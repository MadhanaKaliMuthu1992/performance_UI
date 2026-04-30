const express = require('express');
const multer = require('multer');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const app = express();
const PORT = 7500;

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, os.tmpdir()),
  filename: (req, file, cb) => cb(null, `jmx_${Date.now()}_${file.originalname}`)
});
const upload = multer({
  storage,
  fileFilter: (req, file, cb) => cb(null, file.originalname.endsWith('.jmx'))
});

const clients = new Map();
let activeProcess = null;
const completedReports = new Map();

app.use(express.json());
app.use(express.static(__dirname));

// ─────────────────────────────────────────────────────────────────────────────
// patchJmx — Patches ThreadGroup + LoopController props in any JMX file.
//
// Key fixes:
//  • Handles stringProp / intProp / longProp for every property
//  • INJECTS missing tags (duration, scheduler) directly into the XML
//  • Forces LoopController.continue_forever = true when loops = -1
//    so "Infinite" checkbox is respected at runtime
//  • Forces ThreadGroup.scheduler = true so duration is honoured
// ─────────────────────────────────────────────────────────────────────────────
function patchJmx(jmxPath, { threads, rampup, duration, loops }) {
  let xml = fs.readFileSync(jmxPath, 'utf8');
  const before = xml;

  function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // Replace existing stringProp / intProp / longProp — returns true if found
  function replaceProp(propName, value) {
    let found = false;
    for (const t of ['stringProp', 'intProp', 'longProp']) {
      const re = new RegExp(
        `(<${t} name="${escapeRegex(propName)}">)[^<]*(</${t}>)`, 'g'
      );
      if (re.test(xml)) {
        xml = xml.replace(re, `$1${value}$2`);
        found = true;
      }
    }
    return found;
  }

  // Replace boolProp — returns true if found
  function replaceBoolProp(propName, value) {
    const re = new RegExp(
      `(<boolProp name="${escapeRegex(propName)}">)[^<]*(<\\/boolProp>)`, 'g'
    );
    if (re.test(xml)) {
      xml = xml.replace(re, `$1${value}$2`);
      return true;
    }
    return false;
  }

  // Inject a stringProp before </ThreadGroup> if tag is completely absent
  function injectStringProp(propName, value) {
    if (xml.includes(`name="${propName}"`)) return;
    xml = xml.replace(
      /<\/ThreadGroup>/,
      `        <stringProp name="${propName}">${value}</stringProp>\n      </ThreadGroup>`
    );
    console.log(`[patchJmx] INJECTED stringProp ${propName} = ${value}`);
  }

  // Inject a boolProp before </ThreadGroup> if tag is completely absent
  function injectBoolProp(propName, value) {
    if (xml.includes(`name="${propName}"`)) return;
    xml = xml.replace(
      /<\/ThreadGroup>/,
      `        <boolProp name="${propName}">${value}</boolProp>\n      </ThreadGroup>`
    );
    console.log(`[patchJmx] INJECTED boolProp ${propName} = ${value}`);
  }

  // ── 1. num_threads ──────────────────────────────────────────────────────
  if (!replaceProp('ThreadGroup.num_threads', threads)) {
    injectStringProp('ThreadGroup.num_threads', threads);
  }

  // ── 2. ramp_time ────────────────────────────────────────────────────────
  if (!replaceProp('ThreadGroup.ramp_time', rampup)) {
    injectStringProp('ThreadGroup.ramp_time', rampup);
  }

  // ── 3. duration ─────────────────────────────────────────────────────────
  if (!replaceProp('ThreadGroup.duration', duration)) {
    injectStringProp('ThreadGroup.duration', duration);
  }

  // ── 4. scheduler = true (so duration is respected) ──────────────────────
  if (!replaceBoolProp('ThreadGroup.scheduler', 'true')) {
    injectBoolProp('ThreadGroup.scheduler', 'true');
  }

  // ── 5. LoopController.loops ─────────────────────────────────────────────
  // loops = -1 means infinite; patch both loops count AND continue_forever
  const loopVal = parseInt(loops);
  replaceProp('LoopController.loops', loopVal);

  if (loopVal === -1) {
    // Force "Infinite" checkbox = true
    if (!replaceBoolProp('LoopController.continue_forever', 'true')) {
      // Inject inside LoopController element if missing
      xml = xml.replace(
        /(<LoopController[^>]*>)/,
        `$1\n          <boolProp name="LoopController.continue_forever">true</boolProp>`
      );
      console.log(`[patchJmx] INJECTED LoopController.continue_forever = true`);
    }
  } else {
    // Finite loops — disable continue_forever
    replaceBoolProp('LoopController.continue_forever', 'false');
  }

  // ── Write ───────────────────────────────────────────────────────────────
  const changed = before !== xml;
  fs.writeFileSync(jmxPath, xml, 'utf8');

  // ── Verify ──────────────────────────────────────────────────────────────
  const v = fs.readFileSync(jmxPath, 'utf8');
  const pick = (re) => { const m = v.match(re); return m ? m[1] : 'MISSING'; };

  console.log(`\n[patchJmx] ━━━ Patch Summary ━━━`);
  console.log(`  num_threads        = ${pick(/ThreadGroup\.num_threads[^>]*>([^<]+)</)}`);
  console.log(`  ramp_time          = ${pick(/ThreadGroup\.ramp_time[^>]*>([^<]+)</)}`);
  console.log(`  duration           = ${pick(/ThreadGroup\.duration[^>]*>([^<]+)</)}`);
  console.log(`  scheduler          = ${pick(/ThreadGroup\.scheduler[^>]*>([^<]+)</)}`);
  console.log(`  LoopController     = ${pick(/LoopController\.loops[^>]*>([^<]+)</)}`);
  console.log(`  continue_forever   = ${pick(/LoopController\.continue_forever[^>]*>([^<]+)</)}`);
  console.log(`  XML changed        = ${changed}`);
  console.log(`[patchJmx] ━━━━━━━━━━━━━━━━━━━━━\n`);

  return changed;
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /run
// ─────────────────────────────────────────────────────────────────────────────
app.post('/run', upload.single('jmx'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No valid .jmx file uploaded' });

  const {
    threads    = '1',
    rampup     = '1',
    duration   = '1',
    loops      = '1',
    host       = '',
    port       = '',
    jmeterPath = 'jmeter',
    resultFile = '',
    reportDir  = ''
  } = req.body;

  const jmxPath   = req.file.path;
  const runId     = Date.now().toString();
  const jtlFile   = resultFile || path.join(os.tmpdir(), `results_${runId}.jtl`);
  const reportOut = reportDir  || path.join(os.tmpdir(), `report_${runId}`);

  let patched = false;
  try {
    patched = patchJmx(jmxPath, { threads, rampup, duration, loops });
  } catch (e) {
    console.error('[patchJmx] ERROR:', e.message);
    return res.status(500).json({ error: 'Failed to patch JMX: ' + e.message });
  }

  const args = [
    '-n', '-t', jmxPath,
    `-Jthreads=${threads}`,
    `-Jrampup=${rampup}`,
    `-Jduration=${duration}`,
    `-Jloops=${loops}`,
  ];
  if (host) args.push(`-Jhost=${host}`);
  if (port) args.push(`-Jport=${port}`);
  args.push('-l', jtlFile, '-e', '-o', reportOut);

  const cmd = `${jmeterPath} ${args.join(' ')}`;
  console.log(`[run] CMD: ${cmd}`);

  res.json({ runId, cmd, jtlFile, reportOut, jmxPatched: patched });

  setTimeout(() => {
    const isWin     = process.platform === 'win32';
    const spawnCmd  = isWin ? 'cmd.exe' : jmeterPath;
    const spawnArgs = isWin ? ['/c', jmeterPath, ...args] : args;

    console.log(`[spawn] ${spawnCmd} ${spawnArgs.join(' ')}`);

    const proc = spawn(spawnCmd, spawnArgs, {
      env: { ...process.env },
      windowsHide: true
    });
    activeProcess = proc;

    const broadcast = (data) => {
      const client = clients.get(runId);
      if (client) client.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    broadcast({ type: 'start', cmd, pid: proc.pid });

    proc.stdout.on('data', d => {
      const l = d.toString();
      console.log('[stdout]', l.trim());
      broadcast({ type: 'stdout', line: l });
    });

    proc.stderr.on('data', d => {
      const l = d.toString();
      console.log('[stderr]', l.trim());
      broadcast({ type: 'stderr', line: l });
    });

    proc.on('close', (code) => {
      console.log(`[proc] exited with code ${code}`);
      if (code === 0) completedReports.set(runId, reportOut);
      broadcast({ type: 'done', code, jtlFile, reportOut, runId });
      activeProcess = null;
      fs.unlink(jmxPath, () => {});
      setTimeout(() => {
        clients.delete(runId);
        completedReports.delete(runId);
      }, 3600000);
    });

    proc.on('error', (err) => {
      let msg = err.message;
      if (err.code === 'ENOENT' || err.code === 'EINVAL') {
        msg = [
          `Cannot launch JMeter.`,
          `Path used: "${jmeterPath}"`,
          ``,
          `Windows: C:\\apache-jmeter-5.6.3\\bin\\jmeter.bat`,
          `Linux:   /opt/apache-jmeter-5.6.3/bin/jmeter`,
        ].join('\n');
      }
      console.error('[proc] error:', msg);
      broadcast({ type: 'error', message: msg });
      activeProcess = null;
    });
  }, 150);
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /stream/:runId — SSE
// ─────────────────────────────────────────────────────────────────────────────
app.get('/stream/:runId', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  clients.set(req.params.runId, res);
  req.on('close', () => clients.delete(req.params.runId));
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /stop
// ─────────────────────────────────────────────────────────────────────────────
app.post('/stop', (req, res) => {
  if (activeProcess) {
    activeProcess.kill();
    activeProcess = null;
    res.json({ stopped: true });
  } else {
    res.json({ stopped: false });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /download-report?dir=<path>
// Zips the HTML report folder. Falls back to index.html if archiver missing.
// Run: npm install archiver
// ─────────────────────────────────────────────────────────────────────────────
app.get('/download-report', (req, res) => {
  const reportDir = req.query.dir;
  if (!reportDir) return res.status(400).json({ error: 'Missing ?dir= param' });
  if (!fs.existsSync(reportDir)) {
    return res.status(404).json({ error: 'Report directory not found: ' + reportDir });
  }

  const folderName = path.basename(reportDir);
  const zipName    = `jmeter_report_${folderName}.zip`;

  res.setHeader('Content-Disposition', `attachment; filename="${zipName}"`);
  res.setHeader('Content-Type', 'application/zip');

  try {
    const archiver = require('archiver');
    const archive  = archiver('zip', { zlib: { level: 6 } });
    archive.on('error', err => console.error('[download] zip error:', err.message));
    archive.pipe(res);
    archive.directory(reportDir, folderName);
    archive.finalize();
    console.log(`[download] Streaming ZIP: ${reportDir}`);
  } catch (e) {
    console.warn('[download] archiver not installed — falling back to index.html');
    const indexPath = path.join(reportDir, 'index.html');
    if (fs.existsSync(indexPath)) {
      res.setHeader('Content-Type', 'text/html');
      res.setHeader('Content-Disposition', `attachment; filename="jmeter_report_${folderName}.html"`);
      fs.createReadStream(indexPath).pipe(res);
    } else {
      res.status(500).json({
        error: 'index.html not found and archiver not installed.\nRun: npm install archiver'
      });
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /debug-jmx?file=<path>
// ─────────────────────────────────────────────────────────────────────────────
app.get('/debug-jmx', (req, res) => {
  const file = req.query.file;
  if (!file || !fs.existsSync(file)) return res.json({ error: 'File not found' });
  const xml = fs.readFileSync(file, 'utf8');
  const props = [
    'ThreadGroup.num_threads',
    'ThreadGroup.ramp_time',
    'ThreadGroup.duration',
    'ThreadGroup.scheduler',
    'LoopController.loops',
    'LoopController.continue_forever',
  ];
  const result = {};
  props.forEach(p => {
    const m = xml.match(new RegExp(`name="${p.replace(/\./g,'\\.')}"[^>]*>([^<]+)<`));
    result[p] = m ? m[1] : 'NOT FOUND';
  });
  res.json(result);
});

app.listen(PORT, () => {
  console.log(`\nJMeter Runner UI → http://localhost:${PORT}`);
  console.log(`Platform: ${process.platform}`);
  console.log(`Tip: npm install archiver   (enables full ZIP report downloads)\n`);
});