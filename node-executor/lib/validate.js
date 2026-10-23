'use strict';
const cfg = require('./config');

// Metadados internos do Tato: nunca fazem parte de um projeto Node.
const INTERNAL_FILES = new Set(['.tato_bug_history.json', '.tato_file_signatures.json', '.tato_runtime_profile.json', '.tato_notes_internas.md']);
const RESERVED_TOP = new Set(['node_modules', '.home', '.git', '.npm-cache']);

function fail(code, message) { const e = new Error(message); e.code = code; e.userMessage = message; return e; }

// Normaliza e valida caminho relativo. Retorna string normalizada ou lança.
function safePath(p) {
  if (typeof p !== 'string' || !p.length) throw fail('bad_path', 'caminho vazio ou inválido');
  if (p.length > 300) throw fail('bad_path', 'caminho longo demais');
  if (p.indexOf('\0') !== -1 || /[\r\n]/.test(p)) throw fail('bad_path', 'caminho contém caracteres inválidos');
  if (p.indexOf('\\') !== -1) throw fail('bad_path', 'use "/" como separador: ' + p);
  if (p.charAt(0) === '/' || /^[A-Za-z]:/.test(p)) throw fail('bad_path', 'caminho absoluto não permitido: ' + p);
  const out = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') throw fail('bad_path', 'caminho com ".." não permitido: ' + p);
    out.push(seg);
  }
  if (!out.length) throw fail('bad_path', 'caminho vazio: ' + p);
  if (RESERVED_TOP.has(out[0])) throw fail('bad_path', 'caminho reservado: ' + out[0]);
  return out.join('/');
}

function isStr(v) { return typeof v === 'string'; }

// Valida o corpo do protocolo v1. Retorna objeto normalizado.
function validateRequest(body, principal) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw fail('bad_request', 'corpo JSON inválido');
  if (body.version !== cfg.PROTOCOL_VERSION) throw fail('bad_version', 'versão de protocolo não suportada (esperado ' + cfg.PROTOCOL_VERSION + ')');
  const op = body.op;
  if (['run', 'eval', 'version', 'npm'].indexOf(op) === -1) throw fail('bad_op', 'operação inválida: ' + String(op).slice(0, 40));
  const guest = principal && principal.tier === 'guest';
  if (guest && op === 'npm') throw fail('forbidden', 'npm não está disponível para visitantes; faça login');

  const req = { op, files: [], args: [], stdin: '', limits: {}, writeBack: false };

  // arquivos
  const files = body.files == null ? [] : body.files;
  if (!Array.isArray(files)) throw fail('bad_request', '"files" deve ser uma lista');
  if (files.length > cfg.MAX_FILES) throw fail('too_large', 'arquivos demais no workspace (máx ' + cfg.MAX_FILES + ')');
  const seen = new Set(); let total = 0;
  for (const f of files) {
    if (!f || typeof f !== 'object' || !isStr(f.path) || !isStr(f.content)) throw fail('bad_request', 'arquivo inválido (precisa de path e content em texto)');
    const base = f.path.split('/').pop();
    if (INTERNAL_FILES.has(base)) continue; // descarta metadados internos
    const p = safePath(f.path);
    const lower = p.toLowerCase();
    if (seen.has(lower)) throw fail('bad_path', 'caminho duplicado: ' + p);
    seen.add(lower);
    const bytes = Buffer.byteLength(f.content, 'utf8');
    if (bytes > cfg.MAX_FILE_BYTES) throw fail('too_large', 'arquivo "' + p + '" excede 1 MiB');
    total += bytes;
    if (total > cfg.MAX_TOTAL_BYTES) throw fail('too_large', 'workspace excede o limite total de ' + Math.round(cfg.MAX_TOTAL_BYTES / 1048576) + ' MiB');
    req.files.push({ path: p, content: f.content });
  }

  // argv
  const args = body.args == null ? [] : body.args;
  if (!Array.isArray(args) || args.length > cfg.MAX_ARGS) throw fail('bad_request', '"args" inválido (máx ' + cfg.MAX_ARGS + ')');
  for (const a of args) {
    if (!isStr(a) || a.length > cfg.MAX_ARG_LEN || a.indexOf('\0') !== -1) throw fail('bad_request', 'argumento inválido ou longo demais');
    req.args.push(a);
  }

  // stdin
  if (body.stdin != null) {
    if (!isStr(body.stdin)) throw fail('bad_request', '"stdin" deve ser texto');
    if (Buffer.byteLength(body.stdin, 'utf8') > cfg.MAX_STDIN_BYTES) throw fail('too_large', 'stdin excede 100 KB');
    req.stdin = body.stdin;
  }

  // limites pedidos (o servidor sempre aplica o teto dele)
  const lim = body.limits && typeof body.limits === 'object' ? body.limits : {};
  const maxTimeout = guest ? cfg.GUEST_MAX_TIMEOUT_MS : cfg.MAX_TIMEOUT_MS;
  let t = Number(lim.timeout_ms); if (!Number.isFinite(t) || t <= 0) t = cfg.DEFAULT_TIMEOUT_MS;
  req.limits.timeout_ms = Math.min(Math.max(Math.floor(t), 500), maxTimeout);
  let m = Number(lim.memory_mb); if (!Number.isFinite(m) || m <= 0) m = cfg.DEFAULT_MEMORY_MB;
  req.limits.memory_mb = Math.min(Math.max(Math.floor(m), 64), guest ? 128 : cfg.MAX_MEMORY_MB);

  if (op === 'run') {
    if (!isStr(body.entrypoint)) throw fail('bad_request', 'entrypoint ausente');
    req.entrypoint = safePath(body.entrypoint);
    if (!/\.(js|mjs|cjs)$/i.test(req.entrypoint)) throw fail('bad_request', 'entrypoint deve terminar em .js, .mjs ou .cjs');
    if (!req.files.some(f => f.path === req.entrypoint)) throw fail('missing_file', 'arquivo "' + req.entrypoint + '" não existe no workspace enviado');
  } else if (op === 'eval') {
    if (!isStr(body.eval) || !body.eval.length) throw fail('bad_request', 'código de -e vazio');
    if (Buffer.byteLength(body.eval, 'utf8') > cfg.MAX_EVAL_BYTES) throw fail('too_large', 'código de -e excede 100 KB');
    req.eval = body.eval;
    req.print = body.print === true;
  } else if (op === 'npm') {
    const n = body.npm;
    if (!n || typeof n !== 'object') throw fail('bad_request', '"npm" ausente');
    if (['version', 'install', 'ci', 'run', 'test', 'start'].indexOf(n.subcommand) === -1) throw fail('bad_request', 'subcomando npm não suportado: ' + String(n.subcommand).slice(0, 30));
    req.npm = { subcommand: n.subcommand };
    if (n.subcommand === 'install') {
      // "npm install <pacote>": só nomes de registro (sem URL, git, file:, caminhos ou flags)
      const spec = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*(?:@[A-Za-z0-9._~^<>=|* +-]{1,60})?$/;
      for (const a of req.args) if (!spec.test(a)) throw fail('bad_request', 'pacote npm inválido: ' + a.slice(0, 60) + ' (use nome[@versão] do registro público)');
      req.npm.packages = req.args.slice(); req.args = [];
    } else if (n.subcommand === 'ci' && req.args.length) throw fail('bad_request', 'npm ci não aceita nomes de pacotes');
    if (n.subcommand === 'run') {
      if (!isStr(n.script) || !/^[A-Za-z0-9:_\-.]{1,80}$/.test(n.script)) throw fail('bad_request', 'nome de script npm inválido');
      req.npm.script = n.script;
    }
  }
  req.writeBack = body.writeBack === true && op !== 'version';
  return req;
}

module.exports = { validateRequest, safePath, INTERNAL_FILES, fail };
