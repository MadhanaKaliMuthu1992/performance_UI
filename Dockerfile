FROM node:20-slim 
 
RUN apt-get update && apt-get install -y openjdk-17-jre-headless wget && rm -rf /var/lib/apt/lists/* 
 
ENV JMETER_VERSION=5.6.3 
ENV JMETER_HOME=/opt/apache-jmeter-5.6.3 
ENV PATH=$PATH:/opt/apache-jmeter-5.6.3/bin 
 
RUN wget -q https://downloads.apache.org/jmeter/binaries/apache-jmeter-5.6.3.tgz && tar -xzf apache-jmeter-5.6.3.tgz -C /opt && rm apache-jmeter-5.6.3.tgz 
 
WORKDIR /app 
COPY package*.json ./ 
RUN npm install --production 
COPY . . 
 
EXPOSE 7500 
