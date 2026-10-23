'use strict';
// Cache seguro de dependências npm, chaveado por hash do lockfile (ou das deps) + runtime.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cfg = require('./config');

function sha(s) { return crypto.createHash('sha256').update(s).digest('hex'); }

function readPkg(files) {
  const f = files.find(x => x.path === 'package.json');
  if (!f) return null;
  try { const j = JSON.parse(f.content); return j && typeof j === 'object' ? j : null; } catch (_) { return { __invalid: true }; }
}
function depsOf(pkg) {
  const o = {};
  for (const k of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    if (pkg && pkg[k] && typeof pkg[k] === 'object') for (const n of Object.keys(pkg[k])) o[k + ':' + n] = String(pkg[k][n]);
  }
  return o;
}
function hasDeps(pkg) { return !!pkg && !pkg.__invalid && Object.keys(depsOf(pkg)).length > 0; }

function cacheKey(files, nodeVersion) {
  const pkg = readPkg(files);
  const lock = files.find(x => x.path === 'package-lock.json');
  const runtime = nodeVersion + '|' + process.platform + '|' + process.arch;
  const body = lock ? 'lock:' + lock.content : 'deps:' + JSON.stringify(Object.keys(depsOf(pkg)).sort().map(k => [k, depsOf(pkg)[k]]));
  return sha(runtime + '\n' + body).slice(0, 40);
}

function dirFor(key) { return path.join(cfg.CACHE_ROOT, key); }
function lookup(key) {
  const d = path.join(dirFor(key), 'node_modules');
  if (fs.existsSync(d)) { try { const now = new Date(); fs.utimesSync(dirFor(key), now, now); } catch (_) {} try { return fs.realpathSync(d); } catch (_) { return d; } }
  return null;
}

function dirSize(d) {
  let total = 0;
  const stack = [d];
  while (stack.length) {
    const cur = stack.pop();
    let ents; try { ents = fs.readdirSync(cur, { withFileTypes: true }); } catch (_) { continue; }
    for (const e of ents) {
      const p = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(p);
      else { try { total += fs.lstatSync(p).size; } catch (_) {} }
    }
  }
  return total;
}

// Remove entradas velhas (TTL) e, se passar do teto, as menos recentes (LRU).
function evict() {
  let ents;
  try { ents = fs.readdirSync(cfg.CACHE_ROOT, { withFileTypes: true }).filter(e => e.isDirectory() && !e.name.startsWith('.tmp-')); } catch (_) { return; }
  const rows = ents.map(e => { const p = path.join(cfg.CACHE_ROOT, e.name); let m = 0; try { m = fs.statSync(p).mtimeMs; } catch (_) {} return { p, m, size: dirSize(p) }; });
  const now = Date.now();
  let total = 0;
  rows.sort((a, b) => b.m - a.m);
  for (const r of rows) {
    if (now - r.m > cfg.CACHE_TTL_MS || total + r.size > cfg.CACHE_MAX_BYTES) fs.rmSync(r.p, { recursive: true, force: true });
    else total += r.size;
  }
}

// Publica node_modules instalado no cache (somente-leitura, dono root). Atômico via rename.
function publish(key, installedNodeModules, nodeVersion) {
  const finalDir = dirFor(key);
  if (fs.existsSync(path.join(finalDir, 'node_modules'))) return false;
  fs.mkdirSync(cfg.CACHE_ROOT, { recursive: true, mode: 0o755 });
  const tmp = path.join(cfg.CACHE_ROOT, '.tmp-' + crypto.randomBytes(6).toString('hex'));
  fs.mkdirSync(tmp, { mode: 0o755 });
  try { fs.renameSync(installedNodeModules, path.join(tmp, 'node_modules')); }
  catch (e) { if (e.code !== 'EXDEV') throw e; fs.cpSync(installedNodeModules, path.join(tmp, 'node_modules'), { recursive: true, verbatimSymlinks: true }); }
  fs.writeFileSync(path.join(tmp, 'meta.json'), JSON.stringify({ created: new Date().toISOString(), node: nodeVersion }));
  require('child_process').spawnSync('chown', ['-R', '0:0', tmp]);
  require('child_process').spawnSync('chmod', ['-R', 'a+rX,go-w', tmp]);
  try { fs.renameSync(tmp, finalDir); } catch (_) { fs.rmSync(tmp, { recursive: true, force: true }); return false; }
  setImmediate(() => { try { evict(); } catch (_) {} });
  return true;
}

// Chave alternativa (ex.: antes do lockfile existir) apontando para o mesmo node_modules já publicado.
function alias(fromKey, toKey) {
  if (fromKey === toKey) return;
  const target = path.join(dirFor(toKey), 'node_modules');
  const d = dirFor(fromKey);
  if (!fs.existsSync(target) || fs.existsSync(path.join(d, 'node_modules'))) return;
  fs.mkdirSync(d, { recursive: true, mode: 0o755 });
  try { fs.symlinkSync(target, path.join(d, 'node_modules')); } catch (_) {}
}

module.exports = { alias, readPkg, hasDeps, cacheKey, lookup, publish, evict, dirFor };
