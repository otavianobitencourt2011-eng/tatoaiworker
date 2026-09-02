const express = require('express');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const ONLINECOMPILER_API_KEY = process.env.ONLINECOMPILER_API_KEY;
const TATO_WORKER_TOKEN = process.env.TATO_WORKER_TOKEN;

app.disable('x-powered-by');

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
    workerAuthEnabled: Boolean(TATO_WORKER_TOKEN)
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

  try {
    const response = await fetch(
      'https://api.onlinecompiler.io/api/run-code-sync/',
      {
        method: 'POST',
        headers: {
          'Authorization': ONLINECOMPILER_API_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ compiler, code, input })
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

    return res.status(200).json(data);
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
