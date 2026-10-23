'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const cfg = require('./config');
const sandbox = require('./sandbox');
const procs = require('./procs');
const deps = require('./deps');

const SIGNUM = { SIGHUP: 1, SIGINT: 2, SIGKILL: 9, SIGSEGV: 11, SIGPIPE: 13, SIGTERM: 15, SIGXCPU: 24, SIGXFSZ: 25, SIGABRT: 6 };
let nodeVersionCache = null;

function nodeVersion() {
  if (nodeVersionCache) return nodeVersionCache;
  const r = spawnSync(cfg.NODE_BIN, ['--version'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
  nodeVersionCache = (r.stdout || '').trim() || process.version;
  return nodeVersionCache;
}
function npmCli() {
  if (cfg.NPM_CLI) return cfg.NPM_CLI;
  const base = path.resolve(path.dirname(fs.realpathSync(cfg.NODE_BIN)), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (fs.existsSync(base)) return base;
  const w = spawnSync('sh', ['-c', 'readlink -f "$(command -v npm)"'], { encoding: 'utf8' });
  const p = (w.stdout || '').trim();
  return p && fs.existsSync(p) ? p : null;
}

function mkJobDir(uid) {
  fs.mkdirSync(cfg.WORK_ROOT, { recursive: true, mode: 0o711 });
  try { fs.chmodSync(cfg.WORK_ROOT, 0o711); } catch (_) {}
  const dir = path.join(cfg.WORK_ROOT, crypto.randomBytes(12).toString('hex'));
  fs.mkdirSync(dir, { mode: 0o700 });
  const job = { dir, ws: path.join(dir, 'ws'), home: path.join(dir, 'home'), tmp: path.join(dir, 'tmp'), uid };
  for (const d of [job.ws, job.home, job.tmp]) fs.mkdirSync(d, { mode: 0o700 });
  for (const d of [dir, job.ws, job.home, job.tmp]) fs.chownSync(d, uid, uid);
  return job;
}

function writeFiles(job, files) {
  const made = new Set([job.ws]);
  for (const f of files) {
    const full = path.join(job.ws, f.path);
    if (full.indexOf(job.ws + path.sep) !== 0) throw new Error('caminho fora do workspace');
    const parts = path.relative(job.ws, path.dirname(full)).split(path.sep).filter(Boolean);
    let cur = job.ws;
    for (const p of parts) { cur = path.join(cur, p); if (!made.has(cur)) { fs.mkdirSync(cur, { mode: 0o700 }); fs.chownSync(cur, job.uid, job.uid); made.add(cur); } }
    fs.writeFileSync(full, f.content, { mode: 0o600, flag: 'wx' });
    fs.chownSync(full, job.uid, job.uid);
  }
}

function baseEnv(job, extra) {
  const nodeDir = path.dirname(cfg.NODE_BIN);
  const e = {
    PATH: [nodeDir, '/usr/local/bin', '/usr/bin', '/bin'].join(':'),
    HOME: job.home, TMPDIR: job.tmp, LANG: 'C.UTF-8', NO_COLOR: '1', FORCE_COLOR: '0',
    npm_config_update_notifier: 'false', npm_config_fund: 'false', npm_config_audit: 'false',
    npm_config_cache: path.join(job.tmp, 'npm-cache'), npm_config_loglevel: 'warn', npm_config_progress: 'false'
  };
  return Object.assign(e, extra || {}); // NUNCA repassa process.env do serviço
}

// Executa um processo dentro do sandbox. Retorna resultado estruturado.
function execSandboxed(job, inner, o) {
  return new Promise((resolve) => {
    const mode = sandbox.detect();
    const argv = sandbox.wrap(mode.mode, job, inner, { network: !!o.network, timeoutMs: o.timeoutMs, maxProcs: o.maxProcs });
    const started = Date.now();
    const child = spawn(argv[0], argv.slice(1), { cwd: job.ws, env: o.env || baseEnv(job), stdio: ['pipe', 'pipe', 'pipe'], shell: false, detached: true });
    const out = [], err = [];
    let outB = 0, errB = 0, truncated = false, reason = null, done = false;
    const cap = cfg.MAX_OUTPUT_BYTES;

    const killAll = (why) => {
      if (why && !reason) reason = why;
      try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {}
      try { child.kill('SIGKILL'); } catch (_) {}
      procs.killUid(job.uid);
    };
    const take = (arr, chunk, isOut) => {
      const used = isOut ? outB : errB;
      const room = cap - used;
      if (room <= 0) { truncated = true; killAll('output_limit'); return; }
      const piece = chunk.length > room ? chunk.subarray(0, room) : chunk;
      arr.push(piece);
      if (isOut) outB += piece.length; else errB += piece.length;
      if (chunk.length > room) { truncated = true; killAll('output_limit'); }
    };
    child.stdout.on('data', c => take(out, c, true));
    child.stderr.on('data', c => take(err, c, false));
    child.stdin.on('error', () => {});
    try { if (o.stdin) child.stdin.write(o.stdin); child.stdin.end(); } catch (_) {}

    const timer = setTimeout(() => killAll('timeout'), o.timeoutMs);
    const memLimit = o.memoryMb;
    const watch = setInterval(() => {
      if (done) return;
      if (procs.rssMbOfUid(job.uid) > memLimit) killAll('memory_limit');
    }, 150);
    const onAbort = () => killAll('cancelled');
    if (o.signal) { if (o.signal.aborted) onAbort(); else o.signal.addEventListener('abort', onAbort, { once: true }); }

    const finish = (code, signal, spawnErr) => {
      if (done) return; done = true;
      clearTimeout(timer); clearInterval(watch);
      if (o.signal) o.signal.removeEventListener('abort', onAbort);
      procs.killUid(job.uid); // nada sobrevive à execução
      let exit = code;
      if (exit == null && signal) exit = 128 + (SIGNUM[signal] || 9);
      if (reason === 'timeout') exit = 124;
      resolve({
        stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') + (spawnErr ? '\n' + spawnErr : ''),
        exit_code: exit, signal: signal || (reason ? 'SIGKILL' : null), reason, truncated, duration_ms: Date.now() - started
      });
    };
    child.on('error', e => finish(1, null, 'falha ao iniciar processo: ' + e.code));
    child.on('close', (code, signal) => finish(code, signal));
  });
}

function scrub(text, job) {
  if (!text) return text;
  return text.split(job.ws).join('/workspace').split(job.dir).join('/job').split(cfg.WORK_ROOT).join('/work');
}

function snapshotChanges(job, original) {
  const orig = new Map(original.map(f => [f.path, f.content]));
  const changed = []; const present = new Set();
  const skip = new Set(['node_modules', '.home', '.npm-cache']);
  const stack = [''];
  let total = 0;
  while (stack.length) {
    const rel = stack.pop();
    let ents; try { ents = fs.readdirSync(path.join(job.ws, rel), { withFileTypes: true }); } catch (_) { continue; }
    for (const e of ents) {
      const r = rel ? rel + '/' + e.name : e.name;
      if (!rel && skip.has(e.name)) continue;
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) { stack.push(r); continue; }
      if (!e.isFile()) continue;
      const full = path.join(job.ws, r);
      let st; try { st = fs.lstatSync(full); } catch (_) { continue; }
      if (st.size > cfg.MAX_FILE_BYTES) continue;
      present.add(r);
      let content; try { content = fs.readFileSync(full); } catch (_) { continue; }
      if (content.includes(0)) continue; // só texto
      const text = content.toString('utf8');
      if (orig.get(r) === text) continue;
      total += Buffer.byteLength(text);
      if (total > cfg.MAX_TOTAL_BYTES || changed.length >= 100) break;
      changed.push({ path: r, action: orig.has(r) ? 'write' : 'create', content: text });
    }
  }
  for (const p of orig.keys()) if (!present.has(p)) changed.push({ path: p, action: 'delete' });
  return changed;
}

function result(base, job, r, extra) {
  const status = r.reason === 'timeout' ? 'timeout' : r.reason === 'cancelled' ? 'cancelled' : r.reason ? r.reason : (r.exit_code === 0 ? 'success' : 'error');
  const out = {
    version: cfg.PROTOCOL_VERSION, status,
    stdout: scrub(r.stdout, job), stderr: scrub(r.stderr, job),
    exit_code: r.exit_code, signal: r.signal || null, duration_ms: r.duration_ms,
    node_version: nodeVersion(), timed_out: r.reason === 'timeout', truncated: !!r.truncated
  };
  if (r.reason === 'memory_limit') out.stderr += (out.stderr ? '\n' : '') + '[executor] memória acima do limite; processo encerrado.';
  if (r.reason === 'output_limit') out.stderr += (out.stderr ? '\n' : '') + '[executor] saída acima do limite; processo encerrado.';
  if (r.reason === 'timeout') out.stderr += (out.stderr ? '\n' : '') + '[executor] tempo limite excedido (' + base.limits.timeout_ms + ' ms); árvore de processos encerrada.';
  return Object.assign(out, extra || {});
}

async function installDeps(req, job, opts) {
  const npm = npmCli();
  if (!npm) return { error: 'npm não encontrado no executor' };
  const pkg = deps.readPkg(req.files);
  if (!pkg) return { error: 'package.json não existe neste projeto' };
  if (pkg.__invalid) return { error: 'package.json inválido (JSON malformado)' };
  const pkgs = (req.npm.packages || []);
  const key = deps.cacheKey(req.files, nodeVersion());
  const hit = pkgs.length ? null : deps.lookup(key);
  const hasLock = req.files.some(f => f.path === 'package-lock.json');
  if (req.npm.subcommand === 'ci' && !hasLock) return { error: 'npm ci exige package-lock.json no projeto (use "npm install" para gerar)' };
  if (hit) return { key, cached: true, stdout: 'dependências já estão em cache seguro (chave ' + key.slice(0, 8) + '); nada a instalar.\n', stderr: '', exit_code: 0, duration_ms: 0 };
  // instala em subpasta isolada, só com package.json + lockfile (nenhum código do usuário roda aqui)
  const instDir = path.join(job.dir, 'install');
  fs.mkdirSync(instDir, { mode: 0o700 }); fs.chownSync(instDir, job.uid, job.uid);
  for (const n of ['package.json', 'package-lock.json']) {
    const f = req.files.find(x => x.path === n); if (!f) continue;
    fs.writeFileSync(path.join(instDir, n), f.content, { mode: 0o600 }); fs.chownSync(path.join(instDir, n), job.uid, job.uid);
  }
  const ijob = Object.assign({}, job, { ws: instDir });
  const sub = req.npm.subcommand === 'ci' ? 'ci' : 'install';
  const ienv = baseEnv(job);
  for (const k of cfg.INSTALL_ENV_PASSTHROUGH) if (process.env[k]) ienv[k] = process.env[k]; // só estágio de install (ex.: CA/proxy corporativo)
  if (cfg.NPM_REGISTRY) ienv.npm_config_registry = cfg.NPM_REGISTRY;
  const r = await execSandboxed(ijob, [cfg.NODE_BIN, npm, sub, '--ignore-scripts', '--no-audit', '--no-fund', '--no-update-notifier', '--progress=false'].concat(pkgs), {
    env: ienv, network: true, timeoutMs: cfg.INSTALL_TIMEOUT_MS, memoryMb: Math.max(req.limits.memory_mb, 512), maxProcs: 128, signal: opts.signal
  });
  r.key = key; r.cached = false; r.instDir = instDir;
  if (r.exit_code === 0 && !r.reason) {
    // arquivos de projeto que o npm atualiza por contrato (package.json / package-lock.json) — nunca node_modules
    const after = [];
    for (const n of ['package.json', 'package-lock.json']) {
      try { after.push({ path: n, content: fs.readFileSync(path.join(instDir, n), 'utf8') }); } catch (_) {}
    }
    r.projectFiles = after.filter(a => { const o = req.files.find(f => f.path === a.path); return !o || o.content !== a.content; })
      .map(a => ({ path: a.path, action: req.files.some(f => f.path === a.path) ? 'write' : 'create', content: a.content }));
    const finalKey = deps.cacheKey(after.length ? after.concat(req.files.filter(f => !after.some(a => a.path === f.path))) : req.files, nodeVersion());
    r.key = finalKey;
    const nm = path.join(instDir, 'node_modules');
    if (fs.existsSync(nm)) { deps.publish(finalKey, nm, nodeVersion()); deps.alias(key, finalKey); }
  }
  return r;
}

// Ponto de entrada: executa um pedido já validado.
async function runRequest(req, ctx) {
  const mode = sandbox.detect();
  if (!mode.allowed) {
    return { version: cfg.PROTOCOL_VERSION, status: 'rejected', stdout: '', stderr: 'O executor se recusa a rodar código sem isolamento (' + mode.notes.join('; ') + ').', exit_code: 1, signal: null, duration_ms: 0, node_version: nodeVersion(), timed_out: false, truncated: false };
  }
  const base = { limits: req.limits };
  if (req.op === 'version') {
    return { version: cfg.PROTOCOL_VERSION, status: 'success', stdout: nodeVersion() + '\n', stderr: '', exit_code: 0, signal: null, duration_ms: 0, node_version: nodeVersion(), timed_out: false, truncated: false };
  }
  const job = mkJobDir(ctx.uid);
  try {
    writeFiles(job, req.files);
    const pkg = deps.readPkg(req.files);
    let depsDir = null;
    const wantsDeps = deps.hasDeps(pkg);
    let installNote = '';
    let key = null;

    if (req.op === 'npm' && (req.npm.subcommand === 'install' || req.npm.subcommand === 'ci')) {
      const r = await installDeps(req, job, ctx);
      if (r.error) return { version: cfg.PROTOCOL_VERSION, status: 'error', stdout: '', stderr: 'npm: ' + r.error + '\n', exit_code: 1, signal: null, duration_ms: 0, node_version: nodeVersion(), timed_out: false, truncated: false };
      const extra = {};
      if (r.projectFiles && r.projectFiles.length) extra.changed_files = r.projectFiles;
      extra.cache = r.cached ? 'hit' : 'miss';
      return result(base, job, r, extra);
    }

    if (wantsDeps) {
      key = deps.cacheKey(req.files, nodeVersion());
      depsDir = deps.lookup(key);
      if (!depsDir) installNote = '[aviso] package.json declara dependências, mas elas não estão instaladas. Rode "npm install" (ou "npm ci" com lockfile) antes.\n';
    }
    if (depsDir) {
      if (mode.mode === 'bwrap') { job.depsDir = depsDir; }
      try { fs.symlinkSync(depsDir, path.join(job.ws, 'node_modules')); } catch (_) {}
    }

    const nodeFlags = ['--max-old-space-size=' + Math.max(32, Math.floor(req.limits.memory_mb * 0.75))];
    let inner;
    if (req.op === 'run') inner = [cfg.NODE_BIN].concat(nodeFlags, [req.entrypoint], req.args);
    else if (req.op === 'eval') inner = [cfg.NODE_BIN].concat(nodeFlags, [req.print ? '-p' : '-e', req.eval], req.args.length ? ['--'].concat(req.args) : []);
    else {
      const npm = npmCli();
      if (!npm) return { version: cfg.PROTOCOL_VERSION, status: 'error', stdout: '', stderr: 'npm não encontrado no executor\n', exit_code: 1, signal: null, duration_ms: 0, node_version: nodeVersion(), timed_out: false, truncated: false };
      if (req.npm.subcommand === 'version') {
        const v = spawnSync(cfg.NODE_BIN, [npm, '--version'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: '/tmp' } });
        return { version: cfg.PROTOCOL_VERSION, status: v.status === 0 ? 'success' : 'error', stdout: v.stdout || '', stderr: v.stderr || '', exit_code: v.status, signal: null, duration_ms: 0, node_version: nodeVersion(), timed_out: false, truncated: false };
      }
      if (!pkg) return { version: cfg.PROTOCOL_VERSION, status: 'error', stdout: '', stderr: 'npm: package.json não existe neste projeto\n', exit_code: 1, signal: null, duration_ms: 0, node_version: nodeVersion(), timed_out: false, truncated: false };
      if (pkg.__invalid) return { version: cfg.PROTOCOL_VERSION, status: 'error', stdout: '', stderr: 'npm: package.json inválido (JSON malformado)\n', exit_code: 1, signal: null, duration_ms: 0, node_version: nodeVersion(), timed_out: false, truncated: false };
      const sub = req.npm.subcommand;
      inner = [cfg.NODE_BIN, npm, sub === 'run' ? 'run' : sub].concat(sub === 'run' ? [req.npm.script] : [], ['--ignore-scripts', '--no-audit', '--no-fund', '--no-update-notifier'], req.args.length ? ['--'].concat(req.args) : []);
    }
    const r = await execSandboxed(job, inner, { network: false, timeoutMs: req.limits.timeout_ms, memoryMb: req.limits.memory_mb, stdin: req.stdin, signal: ctx.signal });
    if (installNote) r.stderr = installNote + r.stderr;
    const extra = {};
    if (req.writeBack && r.exit_code === 0 && !r.reason) extra.changed_files = snapshotChanges(job, req.files);
    return result(base, job, r, extra);
  } finally {
    procs.killUid(job.uid);
    try { fs.rmSync(job.dir, { recursive: true, force: true }); } catch (_) {}
  }
}

module.exports = { runRequest, nodeVersion, npmCli };
