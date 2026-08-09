// 探测本机常见代理端口是否正在监听(TCP 可连接即视为有代理在跑),
// 用于设置页"自定义 HTTP 代理"的默认值预填。
const net = require('net');

// Clash(7890)/Clash Verge(7897)/v2rayN(10809 socks,10808 http)/常见 HTTP 代理
const DEFAULT_CANDIDATE_PORTS = [7890, 7897, 10809, 10808, 1080, 8887, 8888, 8080, 1087];

function probePort(port, options) {
  const opts = options || {};
  const host = opts.host || '127.0.0.1';
  const timeoutMs = opts.timeoutMs || 250;
  const netImpl = opts.net || net;
  return new Promise((resolve) => {
    let settled = false;
    const socket = netImpl.connect({ host, port });
    const done = (ok) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

// 并行探测候选端口,返回第一个接受连接的端口;全部失败返回 null。
function detectProxyPort(options) {
  const opts = options || {};
  const ports = opts.ports || DEFAULT_CANDIDATE_PORTS;
  if (!ports.length) return Promise.resolve(null);
  return new Promise((resolve) => {
    let remaining = ports.length;
    let found = false;
    ports.forEach((port) => {
      probePort(port, opts).then((ok) => {
        if (found) return;
        if (ok) {
          found = true;
          resolve(port);
          return;
        }
        remaining -= 1;
        if (remaining === 0) resolve(null);
      });
    });
  });
}

module.exports = { detectProxyPort, probePort, DEFAULT_CANDIDATE_PORTS };
