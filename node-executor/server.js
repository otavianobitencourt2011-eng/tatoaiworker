'use strict';
const http = require('http');
const fs = require('fs');
const cfg = require('./lib/config');
const sandbox = require('./lib/sandbox');
const runner = require('./lib/runner');
const deps = require('./lib/deps');
const { authenticate } = require('./lib/auth');
const { validateRequest } = require('./lib/validate');

const slots = new Array(cfg.MAX_CONCURRENCY).fill(false);      // pool de uids exclusivos
const perPrincipal = new Map();                                 // concorrência por usuário
const hits = new Map();                                         // rate limit (janela deslizante de 60s)

function takeSlot() { const i = slots.indexOf(false); if (i < 0) return -1; slots[i] = true; return i; }
function rateOk(key, limit) {
  const now = Date.now(); const arr = (hits.get(key) || []).filter(t => now - t < 60000);
  if (arr.length >= limit) { hits.set(key, arr); return false; }
  arr.push(now); hits.set(key, arr); return true;
}
setInterval(() => { const now = Date.now(); for (const [k, a] of hits) { const f = a.filter(t => now - t < 60000); if (f.length) hits.set(k, f); else hits.delete(k); } }, 60000).unref();

function corsHeaders(req) {
  const origin = req.headers.origin;
  const h = { 'Vary': 'Origin' };
  if (origin && (!cfg.ALLOWED_ORIGINS.length || cfg.ALLOWED_ORIGINS.includes(origin) || (cfg.ALLOWED_ORIGINS.includes('null') && origin === 'null'))) {
    h['Access-Control-Allow-Origin'] = origin;
    h['Access-Control-Allow-Headers'] = 'Content-Type, Authorization';
    h['Access-Control-Allow-Methods'] = 'POST, GET, OPTIONS';
    h['Access-Control-Max-Age'] = '600';
  }
  return h;
}
function send(res, req, status, obj) {
  if (res.headersSent || res.writableEnded) return;
  const body = JSON.stringify(obj);
  res.writeHead(status, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }, corsHeaders(req)));
  res.end(body);
}
function errBody(code, message, extra) { return Object.assign({ version: cfg.PROTOCOL_VERSION, status: 'rejected', error: message, code }, extra || {}); }

function readBody(req) {
  return new Promise((resolve, reject) => {
    const len = Number(req.headers['content-length'] || 0);
    if (len > cfg.MAX_BODY_BYTES) return reject({ status: 413, code: 'too_large', message: 'request grande demais (máx ' + Math.round(cfg.MAX_BODY_BYTES / 1048576) + ' MiB)' });
    const chunks = []; let n = 0; let over = false;
    req.on('data', c => { n += c.length; if (n > cfg.MAX_BODY_BYTES) { over = true; chunks.length = 0; } else if (!over) chunks.push(c); });
    req.on('end', () => over ? reject({ status: 413, code: 'too_large', message: 'request grande demais (máx ' + Math.round(cfg.MAX_BODY_BYTES / 1048576) + ' MiB)' }) : resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => reject({ status: 400, code: 'bad_request', message: 'falha ao ler o request' }));
  });
}

const server = http.createServer(async (req, res) => {
  const url = (req.url || '').split('?')[0];
  if (req.method === 'OPTIONS') { res.writeHead(204, corsHeaders(req)); return res.end(); }
  if (req.method === 'GET' && (url === '/health' || url === '/')) {
    const sb = sandbox.detect();
    return send(res, req, 200, { ok: true, protocol: cfg.PROTOCOL_VERSION, node_version: runner.nodeVersion(), sandbox: { mode: sb.mode, network_blocked: sb.netBlocked, allowed: sb.allowed }, concurrency: cfg.MAX_CONCURRENCY });
  }
  if (req.method !== 'POST' || url !== '/v1/run') return send(res, req, 404, errBody('not_found', 'rota não encontrada'));

  let principal;
  try { principal = await authenticate(req); } catch (e) { return send(res, req, e.status || 401, errBody('unauthorized', e.message || 'não autorizado')); }

  const limit = principal.tier === 'guest' ? cfg.RATE_GUEST_PER_MIN : cfg.RATE_USER_PER_MIN;
  if (!rateOk(principal.key, limit)) { res.setHeader('Retry-After', '30'); return send(res, req, 429, errBody('rate_limited', 'muitas execuções em pouco tempo; aguarde alguns segundos', { retry_after_s: 30 })); }

  let parsed;
  try {
    const raw = await readBody(req);
    try { parsed = JSON.parse(raw); } catch (_) { return send(res, req, 400, errBody('bad_json', 'JSON malformado')); }
  } catch (e) { return send(res, req, e.status || 400, errBody(e.code || 'bad_request', e.message)); }

  let job;
  try { job = validateRequest(parsed, principal); }
  catch (e) { return send(res, req, e.code === 'forbidden' ? 403 : (e.code === 'too_large' ? 413 : 400), errBody(e.code || 'bad_request', e.userMessage || 'pedido inválido')); }

  if (job.op === 'version') return send(res, req, 200, await runner.runRequest(job, {}));

  const maxPer = principal.tier === 'guest' ? cfg.GUEST_CONCURRENCY : cfg.PER_PRINCIPAL_CONCURRENCY;
  const cur = perPrincipal.get(principal.key) || 0;
  if (cur >= maxPer) return send(res, req, 429, errBody('busy_user', 'você já tem execuções em andamento; aguarde terminar'));
  const slot = takeSlot();
  if (slot < 0) { res.setHeader('Retry-After', '5'); return send(res, req, 503, errBody('busy', 'executor ocupado; tente de novo em instantes', { retry_after_s: 5 })); }
  perPrincipal.set(principal.key, cur + 1);

  // cancelamento: se o cliente fechar a conexão antes da resposta, mata o job
  const ac = new AbortController();
  res.on('close', () => { if (!res.writableEnded) ac.abort(); });
  try {
    const out = await runner.runRequest(job, { uid: cfg.UID_BASE + slot, signal: ac.signal });
    send(res, req, 200, out);
  } catch (e) {
    console.error('[executor] erro interno:', e && e.code || 'desconhecido');
    send(res, req, 500, errBody('internal', 'erro interno do executor'));
  } finally {
    slots[slot] = false;
    const n = (perPrincipal.get(principal.key) || 1) - 1;
    if (n <= 0) perPrincipal.delete(principal.key); else perPrincipal.set(principal.key, n);
  }
});
server.requestTimeout = 150000;
server.headersTimeout = 20000;

function start(port) {
  fs.mkdirSync(cfg.WORK_ROOT, { recursive: true, mode: 0o711 });
  fs.mkdirSync(cfg.CACHE_ROOT, { recursive: true, mode: 0o755 });
  // limpa restos de execuções anteriores (crash/restart)
  try { for (const n of fs.readdirSync(cfg.WORK_ROOT)) fs.rmSync(require('path').join(cfg.WORK_ROOT, n), { recursive: true, force: true }); } catch (_) {}
  try { deps.evict(); } catch (_) {}
  const sb = sandbox.detect();
  console.log('[executor] node ' + runner.nodeVersion() + ' | sandbox=' + sb.mode + ' netBlocked=' + sb.netBlocked + (sb.notes.length ? ' | ' + sb.notes.join('; ') : ''));
  if (!sb.allowed) console.error('[executor] ATENÇÃO: sem isolamento disponível; execuções serão RECUSADAS.');
  return new Promise(r => server.listen(port == null ? cfg.PORT : port, '0.0.0.0', () => r(server)));
}
if (require.main === module) start();
module.exports = { start, server };
