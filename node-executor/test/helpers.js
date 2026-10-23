'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
let child = null, port = 0, workRoot = null, cacheRoot = null;

function freePort() { return 20000 + Math.floor(Math.random() * 20000); }

async function startServer(extraEnv) {
  port = freePort();
  workRoot = fs.mkdtempSync(path.join('/var/tmp', 'tato-test-work-'));
  cacheRoot = fs.mkdtempSync(path.join('/var/tmp', 'tato-test-cache-'));
  fs.chmodSync(workRoot, 0o711); fs.chmodSync(cacheRoot, 0o755);
  const env = Object.assign({}, process.env, {
    PORT: String(port), TATO_INSECURE_NO_AUTH: '1', TATO_WORK_ROOT: workRoot, TATO_CACHE_ROOT: cacheRoot,
    TATO_MAX_BODY_BYTES: String(2 * 1024 * 1024), TATO_RATE_USER_PER_MIN: '1000', TATO_MAX_CONCURRENCY: '3',
    TATO_PER_USER_CONCURRENCY: '3', SECRET_TEST_VAR: 'SEGREDO-DO-SERVICO-123', FIREBASE_SECRET: 'nao-pode-vazar'
  }, extraEnv || {});
  child = spawn(process.execPath, [path.join(ROOT, 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', d => log += d); child.stderr.on('data', d => log += d);
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 100));
    try { const h = await get('/health'); if (h.body && h.body.ok) return { port, log: () => log, health: h.body, workRoot, cacheRoot }; } catch (_) {}
  }
  throw new Error('servidor não subiu: ' + log);
}
function stopServer() {
  if (child) child.kill('SIGKILL'); child = null;
  for (const d of [workRoot, cacheRoot]) if (d) fs.rmSync(d, { recursive: true, force: true });
}
function raw(method, p, body, headers) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: Object.assign({ 'Content-Type': 'application/json' }, data ? { 'Content-Length': Buffer.byteLength(data) } : {}, headers || {}) }, res => {
      let b = ''; res.on('data', c => b += c);
      res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (_) {} resolve({ status: res.statusCode, body: j, text: b }); });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}
const get = p => raw('GET', p);
const run = (body, headers) => raw('POST', '/v1/run', Object.assign({ version: 1 }, body), headers);
const runRaw = (text, headers) => raw('POST', '/v1/run', text, headers);
const files = obj => Object.keys(obj).map(k => ({ path: k, content: obj[k] }));
function leftoverProcs() {
  let n = 0;
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try { const st = fs.readFileSync('/proc/' + d + '/status', 'utf8'); const m = /Uid:\s+(\d+)/.exec(st); if (m && Number(m[1]) >= 41000 && Number(m[1]) < 41100 && !/^State:\s+Z/m.test(st)) n++; } catch (_) {}
  }
  return n;
}
module.exports = { startServer, stopServer, run, runRaw, raw, get, files, leftoverProcs, ROOT, getPort: () => port, getWorkRoot: () => workRoot };
