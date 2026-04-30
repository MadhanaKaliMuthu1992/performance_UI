const express = require('express');
const multer  = require('multer');
const { spawn } = require('child_process');
const path = require('path');
const fs   = require('fs');
const os   = require('os');

const app  = express();
// PORT from env (Railway sets this automatically) or fallback 7500
const PORT = process.env.PORT || 7500;

// JMeter path: env var > auto-detect > default
function detectJmeter() {
  if (process.env.JMETER_PATH) return process.env.JMETER_PATH;
  const candidates = [
    '/opt/apache-jmeter-5.6.3/bin/jmeter',
    '/opt/jmeter/bin/jmeter',
    'jmeter'
  ];
  for (const c of candidates) {
    if (c === 'jmeter') return c;
    if (fs.existsSync(c)) return c;
  }
  return 'jmeter';
}
const DEFAULT_JMETER = detectJmeter();
console.log(`[boot] JMeter path: ${DEFAULT_JMETER}`);
console.log(`[boot] Platform: ${process.platform}`);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, os.tmpdir()),
  filename:    (req, file, cb) => cb(null, `jmx_${Date.now()}_${file.originalname}`)
});
const upload = multer({
  storage,
  fileFilter: (req, file, cb) => cb(null, file.originalname.endsWith('.jmx'))
});

const clients = new Map();
let activeProcess = null;

app.use(express.json());
app.use(express.static(__dirname));

// ─────────────────────────────────────────────────────────────
// READ JMX CONFIG
// ─────────────────────────────────────────────────────────────
function readJmxConfig(xml) {
  function getProp(name) {
    const m = xml.match(new RegExp(`name="${name.replace(/\./g,'\\.')}"[^>]*>([^<]+)<`));
    return m ? m[1].trim() : null;
  }
  function getBool(name) {
    const m = getProp(name);
    return m === 'true';
  }
  const threads  = getProp('ThreadGroup.num_threads') || '1';
  const rampup   = getProp('ThreadGroup.ramp_time')   || '1';
  const duration = getProp('ThreadGroup.duration')    || '60';
  const loops    = getProp('LoopController.loops')    || '1';
  const infinite = getBool('LoopController.continue_forever');
  return {
    threads, rampup, duration,
    loops: (infinite || loops === '-1') ? '-1' : loops,
    scheduler: getBool('ThreadGroup.scheduler')
  };
}

// ─────────────────────────────────────────────────────────────
// PATCH JMX
// ─────────────────────────────────────────────────────────────
function patchJmx(jmxPath, { threads, rampup, duration, loops }) {
  let xml = fs.readFileSync(jmxPath, 'utf8');

  function esc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'); }

  function replaceProp(name, val) {
    let found = false;
    for (const t of ['stringProp','intProp','longProp']) {
      const re = new RegExp(`(<${t} name="${esc(name)}">)[^<]*(</${t}>)`,'g');
      if (re.test(xml)) { xml = xml.replace(re,`$1${val}$2`); found=true; }
    }
    if (!found) {
      xml = xml.replace(/<\/ThreadGroup>/,
        `        <stringProp name="${name}">${val}</stringProp>\n      </ThreadGroup>`);
    }
  }

  function replaceBool(name, val) {
    const re = new RegExp(`(<boolProp name="${esc(name)}">)[^<]*(<\\/boolProp>)`,'g');
    if (re.test(xml)) { xml = xml.replace(re,`$1${val}$2`); }
    else {
      xml = xml.replace(/<\/ThreadGroup>/,
        `        <boolProp name="${name}">${val}</boolProp>\n      </ThreadGroup>`);
    }
  }

  replaceProp('ThreadGroup.num_threads', threads);
  replaceProp('ThreadGroup.ramp_time',   rampup);
  replaceProp('ThreadGroup.duration',    duration);
  replaceBool('ThreadGroup.scheduler',   'true');

  const lv = parseInt(loops);
  replaceProp('LoopController.loops', lv);
  const re2 = /(<boolProp name="LoopController\.continue_forever">)[^<]*(<\/boolProp>)/g;
  if (re2.test(xml)) xml = xml.replace(re2, `$1${lv===-1?'true':'false'}$2`);
  else if (lv===-1) {
    xml = xml.replace(/(<LoopController[^>]*>)/,
      `$1\n          <boolProp name="LoopController.continue_forever">true</boolProp>`);
  }

  fs.writeFileSync(jmxPath, xml, 'utf8');

  // Verify
  const v = fs.readFileSync(jmxPath,'utf8');
  const pick = re => { const m=v.match(re); return m?m[1]:'MISSING'; };
  console.log('[patch] threads  =', pick(/ThreadGroup\.num_threads[^>]*>([^<]+)</));
  console.log('[patch] rampup   =', pick(/ThreadGroup\.ramp_time[^>]*>([^<]+)</));
  console.log('[patch] duration =', pick(/ThreadGroup\.duration[^>]*>([^<]+)</));
  console.log('[patch] scheduler=', pick(/ThreadGroup\.scheduler[^>]*>([^<]+)</));
  console.log('[patch] loops    =', pick(/LoopController\.loops[^>]*>([^<]+)</));
}

// ─────────────────────────────────────────────────────────────
// POST /parse — read JMX config, return to UI for pre-fill
// ─────────────────────────────────────────────────────────────
app.post('/parse', upload.single('jmx'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No JMX file' });
  try {
    const xml    = fs.readFileSync(req.file.path, 'utf8');
    const config = readJmxConfig(xml);
    fs.unlink(req.file.path, ()=>{});
    res.json({ config });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /run
// ─────────────────────────────────────────────────────────────
app.post('/run', upload.single('jmx'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No valid .jmx file uploaded' });

  const {
    threads    = '10', rampup    = '30',
    duration   = '60', loops     = '-1',
    host       = '',   port      = '',
    jmeterPath = DEFAULT_JMETER,
    resultFile = '',   reportDir = ''
  } = req.body;

  const jmxPath   = req.file.path;
  const runId     = Date.now().toString();
  const jtlFile   = resultFile || path.join(os.tmpdir(), `results_${runId}.jtl`);
  const reportOut = reportDir  || path.join(os.tmpdir(), `report_${runId}`);

  try { patchJmx(jmxPath, { threads, rampup, duration, loops }); }
  catch(e) { return res.status(500).json({ error: 'Patch failed: '+e.message }); }

  const args = [
    '-n', '-t', jmxPath,
    `-Jthreads=${threads}`, `-Jrampup=${rampup}`,
    `-Jduration=${duration}`, `-Jloops=${loops}`
  ];
  if (host) args.push(`-Jhost=${host}`);
  if (port) args.push(`-Jport=${port}`);
  args.push('-l', jtlFile, '-e', '-o', reportOut);

  const cmd = `${jmeterPath} ${args.join(' ')}`;
  console.log('[run] CMD:', cmd);
  res.json({ runId, cmd, jtlFile, reportOut });

  setTimeout(() => {
    const isWin     = process.platform === 'win32';
    const spawnCmd  = isWin ? 'cmd.exe' : jmeterPath;
    const spawnArgs = isWin ? ['/c', jmeterPath, ...args] : args;

    const proc = spawn(spawnCmd, spawnArgs, {
      env: { ...process.env },
      windowsHide: true
    });
    activeProcess = proc;

    const broadcast = d => {
      const c = clients.get(runId);
      if (c) c.write(`data: ${JSON.stringify(d)}\n\n`);
    };

    broadcast({ type:'start', cmd, pid:proc.pid });
    proc.stdout.on('data', d => { const l=d.toString(); console.log('[out]',l.trim()); broadcast({type:'stdout',line:l}); });
    proc.stderr.on('data', d => { const l=d.toString(); console.log('[err]',l.trim()); broadcast({type:'stderr',line:l}); });

    proc.on('close', code => {
      console.log('[proc] exit', code);
      broadcast({ type:'done', code, jtlFile, reportOut });
      activeProcess = null;
      fs.unlink(jmxPath, ()=>{});
      setTimeout(() => clients.delete(runId), 3600000);
    });

    proc.on('error', err => {
      let msg = err.message;
      if (err.code==='ENOENT'||err.code==='EINVAL') {
        msg = `Cannot launch JMeter.\nPath tried: "${jmeterPath}"\n\nOn this server JMeter should be at:\n  ${DEFAULT_JMETER}`;
      }
      console.error('[proc] error:', msg);
      broadcast({ type:'error', message:msg });
      activeProcess = null;
    });
  }, 150);
});

// ─────────────────────────────────────────────────────────────
// GET /stream/:runId  SSE
// ─────────────────────────────────────────────────────────────
app.get('/stream/:runId', (req, res) => {
  res.setHeader('Content-Type','text/event-stream');
  res.setHeader('Cache-Control','no-cache');
  res.setHeader('Connection','keep-alive');
  res.setHeader('X-Accel-Buffering','no'); // disable Nginx buffering for SSE
  res.flushHeaders();
  clients.set(req.params.runId, res);
  req.on('close', () => clients.delete(req.params.runId));
});

// POST /stop
app.post('/stop', (req, res) => {
  if (activeProcess) { activeProcess.kill(); activeProcess=null; res.json({stopped:true}); }
  else res.json({stopped:false});
});

// Health check (required by Railway/Render)
app.get('/health', (req, res) => res.json({ status:'ok', jmeter:DEFAULT_JMETER, platform:process.platform }));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\nJMeter Runner UI → http://localhost:${PORT}`);
  console.log(`JMeter: ${DEFAULT_JMETER}`);
  console.log(`Platform: ${process.platform}\n`);
});