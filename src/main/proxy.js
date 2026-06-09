const http = require('http');
const https = require('https');

class ProxyServer {
  constructor(port, apiKey, aggregator, onStatusChange) {
    this.port = port;
    this.apiKey = apiKey;
    this.aggregator = aggregator;
    this.onStatusChange = onStatusChange;
    this.server = null;
    this.running = false;
    this.activeSince = null;
  }

  start() {
    return new Promise((resolve, reject) => {
      if (this.server) this.stop();

      this.server = http.createServer((clientReq, clientRes) => {
        this.handleRequest(clientReq, clientRes);
      });

      this.server.on('error', (err) => {
        this.running = false;
        if (this.onStatusChange) {
          this.onStatusChange({ running: false, port: this.port, error: err.message });
        }
        reject(err);
      });

      this.server.listen(this.port, '127.0.0.1', () => {
        this.running = true;
        this.activeSince = Date.now();
        if (this.onStatusChange) {
          this.onStatusChange({ running: true, port: this.port, activeSince: this.activeSince });
        }
        resolve();
      });
    });
  }

  stop() {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          this.running = false;
          this.server = null;
          if (this.onStatusChange) {
            this.onStatusChange({ running: false, port: this.port });
          }
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  updateApiKey(apiKey) {
    this.apiKey = apiKey;
  }

  handleRequest(clientReq, clientRes) {
    const { method, headers, url } = clientReq;

    const options = {
      hostname: 'api.deepseek.com',
      port: 443,
      path: url,
      method: method,
      headers: { ...headers },
      rejectUnauthorized: true
    };

    delete options.headers.host;
    options.headers['Authorization'] = `Bearer ${this.apiKey}`;

    const proxyReq = https.request(options, (proxyRes) => {
      const isChatCompletion = url && url.includes('/chat/completions');
      let bodyBuffer = isChatCompletion ? [] : null;

      if (isChatCompletion) {
        proxyRes.on('data', (chunk) => {
          bodyBuffer.push(chunk);
          clientRes.write(chunk);
        });
        proxyRes.on('end', () => {
          clientRes.end();
          try {
            const body = Buffer.concat(bodyBuffer).toString();
            const data = JSON.parse(body);
            if (data.usage && data.model) {
              this.aggregator.update(data.model, data.usage);
            }
          } catch (e) {
            // Non-JSON response or parse failure, ignore
          }
        });
      } else {
        clientRes.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(clientRes);
      }
    });

    proxyReq.on('error', (err) => {
      clientRes.writeHead(502);
      clientRes.end(JSON.stringify({ error: 'Proxy error', message: err.message }));
    });

    proxyReq.setTimeout(120000, () => {
      proxyReq.destroy();
      clientRes.writeHead(504);
      clientRes.end(JSON.stringify({ error: 'Upstream timeout' }));
    });

    clientReq.pipe(proxyReq);
  }
}

module.exports = ProxyServer;
