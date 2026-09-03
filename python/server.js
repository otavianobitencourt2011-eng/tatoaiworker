const express = require('express');
const { spawnSync } = require('child_process');
const vm = require('vm');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const ONLINECOMPILER_API_KEY = process.env.ONLINECOMPILER_API_KEY;
const TATO_WORKER_TOKEN = process.env.TATO_WORKER_TOKEN;

app.disable('x-powered-by');

/*
 * -----------------------------------------------------------------------
 * Auto-fix local de erros triviais (sem IA, sem custo de token).
 * Roda ANTES de mandar o código pro OnlineCompiler. Corrige só casos
 * determinísticos e óbvios; nunca tenta "adivinhar" lógica de negócio.
 * Se não tiver certeza, deixa o erro passar intacto pro fluxo normal
 * (usuário/modelo vê o erro real do compilador).
 * -----------------------------------------------------------------------
 */

const PY_COMPILERS = new Set(['python', 'python3', 'py', 'py3']);
const JS_COMPILERS = new Set(['javascript', 'js', 'node', 'nodejs']);

function pythonAvailable() {
  try {
    const probe = spawnSync('python3', ['--version'], { timeout: 3000 });
    return probe.status === 0;
  } catch {
    return false;
  }
}
const HAS_PYTHON3 = pythonAvailable();

// Checa sintaxe Python via `ast.parse` (interpretador local, grátis) e
// devolve {ok, lineno, msg} sem nunca executar o código do usuário.
function pySyntaxCheck(code) {
  if (!HAS_PYTHON3) return { ok: true, skipped: true };
  const script =
    'import sys,ast\n' +
    'src=sys.stdin.read()\n' +
    'try:\n' +
    '    ast.parse(src)\n' +
    '    print("OK")\n' +
    'except SyntaxError as e:\n' +
    '    print(f"ERR:{e.lineno or 0}:{e.msg}")\n';
  const result = spawnSync('python3', ['-c', script], {
    input: code,
    timeout: 4000,
    maxBuffer: 1024 * 1024
  });
  const out = String(result.stdout || '').trim();
  if (out === 'OK') return { ok: true };
  const m = out.match(/^ERR:(\d+):(.*)$/s);
  if (m) return { ok: false, lineno: Number(m[1]), msg: m[2] };
  return { ok: true, skipped: true }; // não conseguiu checar -> não bloqueia
}

// Fixes determinísticos e conservadores pra Python. Cada um só age quando
// o padrão é inequívoco; nunca reescreve lógica.
function pyAutofixPass(code) {
  const fixes = [];
  let out = code;

  // 1) Tabs e espaços misturados na indentação -> normaliza tab para 4 espaços.
  if (/^[ \t]*\t/m.test(out) && /^[ \t]* {1,3}[^\t\n]/m.test(out) === false) {
    // só mexe se detectar tab de fato presente na indentação
  }
  if (/\t/.test(out)) {
    const before = out;
    out = out.replace(/^([ \t]*)/gm, (m0) => m0.replace(/\t/g, '    '));
    if (out !== before) fixes.push('Convertidas tabs para espaços na indentação');
  }

  // 2) `print` estilo Python 2 -> print(...)
  const py2print = /^(\s*)print (?!\()(.+)$/gm;
  if (py2print.test(out)) {
    out = out.replace(/^(\s*)print (?!\()(.+)$/gm, '$1print($2)');
    fixes.push('Convertido "print X" (Python 2) para "print(X)"');
  }

  // 3) Dois-pontos faltando no fim de linhas de controle (if/for/while/def/class/elif/else/try/except/finally/with)
  const ctrlRe = /^(\s*)(if|elif|else|for|while|def|class|try|except(?:\s+\w+(?:\s+as\s+\w+)?)?|finally|with(?:\s+.+?)?)\s*([^:#\n]*?)\s*(#.*)?$/;
  out = out
    .split('\n')
    .map((line) => {
      const m = line.match(ctrlRe);
      if (!m) return line;
      const [, indent, kw, rest, comment] = m;
      const trimmedRest = rest.trim();
      // else/try/finally não têm condição; os outros normalmente têm.
      const needsCond = !['else', 'try', 'finally'].includes(kw);
      if (needsCond && !trimmedRest) return line; // provavelmente não é um cabeçalho de bloco de verdade
      const already = line.trimEnd().endsWith(':');
      if (already) return line;
      fixes.push(`Adicionado ":" faltando em bloco "${kw}"`);
      return `${indent}${kw}${rest ? ' ' + trimmedRest : ''}:${comment ? ' ' + comment : ''}`;
    })
    .join('\n');

  return { code: out, fixes };
}

function pyAutofix(code) {
  let current = code;
  const allFixes = [];
  for (let i = 0; i < 3; i++) {
    const check = pySyntaxCheck(current);
    if (check.ok) break;
    const { code: next, fixes } = pyAutofixPass(current);
    if (!fixes.length || next === current) break; // nada mais a fazer sem arriscar
    current = next;
    allFixes.push(...fixes);
  }
  const final = pySyntaxCheck(current);
  return { code: current, fixes: [...new Set(allFixes)], stillBroken: !final.ok && !final.skipped };
}

// Checa sintaxe JS local (grátis, via vm do próprio Node) sem executar o código.
function jsSyntaxCheck(code) {
  try {
    new vm.Script(code);
    return { ok: true };
  } catch (e) {
    return { ok: false, msg: e instanceof Error ? e.message : String(e) };
  }
}

// Único fix seguro pra JS sem interpretar lógica: fechar chaves/colchetes/
// parênteses que ficaram abertos no fim do arquivo (nunca remove nada).
function jsAutofix(code) {
  const check = jsSyntaxCheck(code);
  if (check.ok) return { code, fixes: [], stillBroken: false };

  const pairs = { '(': ')', '[': ']', '{': '}' };
  const stack = [];
  let inStr = null;
  let escaped = false;
  for (const ch of code) {
    if (inStr) {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { inStr = ch; continue; }
    if (pairs[ch]) stack.push(pairs[ch]);
    else if (Object.values(pairs).includes(ch)) {
      if (stack[stack.length - 1] === ch) stack.pop();
    }
  }
  if (!stack.length || inStr) return { code, fixes: [], stillBroken: true };

  const closing = stack.reverse().join('');
  const candidate = code + '\n' + closing;
  const recheck = jsSyntaxCheck(candidate);
  if (recheck.ok) {
    return { code: candidate, fixes: [`Fechado(s) "${closing}" que faltava(m) no fim do arquivo`], stillBroken: false };
  }
  return { code, fixes: [], stillBroken: true };
}

function localAutofix(compiler, code) {
  const c = String(compiler || '').toLowerCase();
  if (PY_COMPILERS.has(c)) return pyAutofix(code);
  if (JS_COMPILERS.has(c)) return jsAutofix(code);
  return { code, fixes: [], stillBroken: false };
}


/*
 * CORS
 * O navegador faz um preflight OPTIONS antes do POST /execute
 * por causa do Content-Type e, eventualmente, do Authorization.
 * O preflight precisa ser respondido antes da autenticação e da rota.
 */
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  next();
});

app.use(express.json({ limit: '150kb' }));

function requireWorkerToken(req, res, next) {
  if (!TATO_WORKER_TOKEN) return next();

  const auth = req.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';

  if (token !== TATO_WORKER_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  next();
}

app.get('/', (_req, res) => {
  res.json({
    ok: true,
    service: 'tato-onlinecompiler-worker',
    status: 'online'
  });
});

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    onlinecompilerConfigured: Boolean(ONLINECOMPILER_API_KEY),
    workerAuthEnabled: Boolean(TATO_WORKER_TOKEN),
    localAutofixPython: HAS_PYTHON3
  });
});

app.post('/execute', requireWorkerToken, async (req, res) => {
  if (!ONLINECOMPILER_API_KEY) {
    return res.status(500).json({
      error: 'ONLINECOMPILER_API_KEY is not configured on the server.'
    });
  }

  const { compiler, code, input = '' } = req.body || {};

  if (typeof compiler !== 'string' || !compiler.trim()) {
    return res.status(400).json({ error: 'compiler is required.' });
  }

  if (typeof code !== 'string') {
    return res.status(400).json({ error: 'code must be a string.' });
  }

  if (typeof input !== 'string') {
    return res.status(400).json({ error: 'input must be a string.' });
  }

  if (Buffer.byteLength(code, 'utf8') > 100 * 1024) {
    return res.status(413).json({ error: 'Code exceeds the 100KB limit.' });
  }

  if (Buffer.byteLength(input, 'utf8') > 100 * 1024) {
    return res.status(413).json({ error: 'Input exceeds the 100KB limit.' });
  }

  // Auto-fix local (sem IA) de erros triviais de sintaxe antes de executar.
  // Isso evita gastar uma chamada ao modelo pra corrigir coisa mecânica
  // (colchete faltando, "print X" estilo Python 2, indentação com tab, etc).
  let codeToRun = code;
  let autofix = { applied: false, fixes: [] };
  const fixResult = localAutofix(compiler, code);
  if (fixResult.fixes && fixResult.fixes.length && fixResult.code !== code) {
    codeToRun = fixResult.code;
    autofix = { applied: true, fixes: fixResult.fixes };
  }

  try {
    const response = await fetch(
      'https://api.onlinecompiler.io/api/run-code-sync/',
      {
        method: 'POST',
        headers: {
          'Authorization': ONLINECOMPILER_API_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ compiler, code: codeToRun, input })
      }
    );

    const text = await response.text();

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }

    if (!response.ok) {
      return res.status(response.status).json({
        error: 'OnlineCompiler request failed.',
        details: data
      });
    }

    return res.status(200).json({ ...data, autofix });
  } catch (error) {
    console.error('OnlineCompiler error:', error);

    return res.status(502).json({
      error: 'Failed to reach OnlineCompiler.',
      details: error instanceof Error ? error.message : String(error)
    });
  }
});

app.use((err, _req, res, _next) => {
  console.error('Unhandled server error:', err);
  res.status(500).json({ error: 'Internal server error.' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Tato worker listening on port ${PORT}`);
});
