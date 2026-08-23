// tato-flash-worker.js â€” worker de IA do Tato 2.6 Flash
// A chave da API fica exclusivamente na variÃ¡vel de ambiente AGNES_API_KEY.
// Nunca coloque a chave diretamente neste arquivo.

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');

const app = express();

app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['Content-Type', 'Authorization'] }));
app.use(express.json({ limit: '10mb' }));

const PORT = Number(process.env.PORT) || 3000;
const AGNES_API_KEY = String(process.env.AGNES_API_KEY || '').trim();
const AGNES_API_URL = String(
  process.env.AGNES_API_URL || 'https://api.agnes.ai/v1/chat/completions'
).trim();
const AGNES_MODEL = 'agnes-2.5-flash';
const REQUEST_TIMEOUT_MS = Math.max(10_000, Number(process.env.UPSTREAM_TIMEOUT_MS) || 120_000);

function makeRequestId() {
  try {
    return crypto.randomUUID();
  } catch (_) {
    return 'tato-' + Date.now() + '-' + Math.random().toString(16).slice(2);
  }
}

function sanitizeErrorText(value) {
  let text = String(value == null ? '' : value).trim();
  if (!text) return '';

  // Nunca devolvemos a chave da API, mesmo que algum upstream a reflita por acidente.
  if (AGNES_API_KEY) text = text.split(AGNES_API_KEY).join('[REDACTED]');

  return text.slice(0, 4000);
}

async function readUpstreamBody(response) {
  const raw = await response.text().catch(() => '');
  if (!raw) return { raw: '', data: null };

  try {
    return { raw, data: JSON.parse(raw) };
  } catch (_) {
    return { raw, data: null };
  }
}

function extractUpstreamError(data, raw) {
  if (data && typeof data === 'object') {
    const candidates = [
      data.error?.message,
      data.error?.detail,
      typeof data.error === 'string' ? data.error : '',
      data.message,
      data.detail,
      data.status?.message,
      data.status?.detail
    ];

    for (const candidate of candidates) {
      const text = sanitizeErrorText(candidate);
      if (text) return text;
    }
  }

  const rawText = sanitizeErrorText(raw);
  return rawText || 'A API upstream nÃ£o forneceu uma mensagem de erro.';
}

function extractReply(data) {
  const candidates = [
    data?.choices?.[0]?.message?.content,
    data?.choices?.[0]?.text,
    data?.reply,
    data?.output_text,
    data?.output?.[0]?.content?.[0]?.text
  ];

  for (const value of candidates) {
    if (typeof value === 'string' && value.trim()) return value;
  }

  return '';
}

function errorResponse(res, status, code, message, details, requestId) {
  const safeDetails = sanitizeErrorText(details);
  console.error('[tato-flash-worker]', {
    requestId,
    status,
    code,
    message,
    details: safeDetails || undefined
  });

  return res.status(status).json({
    ok: false,
    error: message,
    code,
    request_id: requestId,
    details: safeDetails || undefined
  });
}

app.get('/', (req, res) => {
  res.json({
    ok: true,
    service: 'tato-flash-worker',
    model: AGNES_MODEL,
    upstream_configured: !!AGNES_API_URL,
    key_configured: !!AGNES_API_KEY
  });
});

app.get('/health', (req, res) => {
  res.status(200).json({
    ok: true,
    service: 'tato-flash-worker',
    model: AGNES_MODEL
  });
});

app.options('*', (req, res) => {
  res.status(204).end();
});

app.post('/', async (req, res) => {
  const requestId = makeRequestId();
  const startedAt = Date.now();

  try {
    if (!AGNES_API_KEY) {
      return errorResponse(
        res,
        500,
        'MISSING_API_KEY',
        'A chave da API do Tato 2.6 Flash nÃ£o estÃ¡ configurada no Render.',
        'Defina a variÃ¡vel de ambiente AGNES_API_KEY no serviÃ§o do worker e faÃ§a um novo deploy.',
        requestId
      );
    }

    if (!AGNES_API_URL) {
      return errorResponse(
        res,
        500,
        'MISSING_API_URL',
        'A URL da API do Tato 2.6 Flash nÃ£o estÃ¡ configurada.',
        'Defina AGNES_API_URL ou permita que o worker use a URL padrÃ£o.',
        requestId
      );
    }

    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const messages = Array.isArray(body.messages) ? body.messages : null;
    const prompt = typeof body.prompt === 'string' ? body.prompt : '';

    const chatMessages = messages && messages.length
      ? messages
      : prompt.trim()
        ? [{ role: 'user', content: prompt }]
        : [];

    if (!chatMessages.length) {
      return errorResponse(
        res,
        400,
        'EMPTY_MESSAGES',
        'Nenhuma mensagem foi enviada ao worker.',
        'Envie body.messages como array ou body.prompt como texto.',
        requestId
      );
    }

    console.log('[tato-flash-worker] request', {
      requestId,
      model: AGNES_MODEL,
      upstream: AGNES_API_URL,
      messages: chatMessages.length
    });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let upstream;
    try {
      upstream = await fetch(AGNES_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${AGNES_API_KEY}`
        },
        body: JSON.stringify({
          model: AGNES_MODEL,
          messages: chatMessages,
          stream: false
        }),
        signal: controller.signal
      });
    } catch (fetchError) {
      clearTimeout(timeout);

      if (fetchError && fetchError.name === 'AbortError') {
        return errorResponse(
          res,
          504,
          'UPSTREAM_TIMEOUT',
          'A API do Tato 2.6 Flash demorou demais para responder.',
          `Timeout de ${REQUEST_TIMEOUT_MS} ms.`,
          requestId
        );
      }

      return errorResponse(
        res,
        502,
        'UPSTREAM_NETWORK_ERROR',
        'NÃ£o foi possÃ­vel conectar Ã  API do Tato 2.6 Flash.',
        fetchError?.message || fetchError,
        requestId
      );
    } finally {
      clearTimeout(timeout);
    }

    const upstreamBody = await readUpstreamBody(upstream);
    const elapsedMs = Date.now() - startedAt;

    if (!upstream.ok) {
      const details = extractUpstreamError(upstreamBody.data, upstreamBody.raw);
      return errorResponse(
        res,
        502,
        'UPSTREAM_API_ERROR',
        `A API do Tato 2.6 Flash respondeu com HTTP ${upstream.status}.`,
        details,
        requestId
      );
    }

    if (!upstreamBody.data) {
      return errorResponse(
        res,
        502,
        'INVALID_UPSTREAM_JSON',
        'A API do Tato 2.6 Flash retornou uma resposta que nÃ£o Ã© JSON vÃ¡lido.',
        upstreamBody.raw,
        requestId
      );
    }

    const reply = extractReply(upstreamBody.data);

    if (!reply) {
      return errorResponse(
        res,
        502,
        'EMPTY_UPSTREAM_REPLY',
        'A API do Tato 2.6 Flash respondeu, mas nÃ£o trouxe texto de resposta.',
        JSON.stringify(upstreamBody.data),
        requestId
      );
    }

    console.log('[tato-flash-worker] success', {
      requestId,
      status: upstream.status,
      elapsedMs,
      replyChars: reply.length
    });

    return res.json({
      ok: true,
      reply,
      model: AGNES_MODEL,
      request_id: requestId,
      elapsed_ms: elapsedMs
    });
  } catch (err) {
    return errorResponse(
      res,
      500,
      'WORKER_INTERNAL_ERROR',
      'Erro interno no worker do Tato 2.6 Flash.',
      err?.stack || err?.message || err,
      requestId
    );
  }
});

app.use((err, req, res, next) => {
  const requestId = makeRequestId();

  if (err && (err.type === 'entity.too.large' || err.status === 413)) {
    return errorResponse(
      res,
      413,
      'PAYLOAD_TOO_LARGE',
      'A mensagem enviada ao Tato 2.6 Flash Ã© grande demais para este worker.',
      'Limite atual do body: 10 MB.',
      requestId
    );
  }

  return errorResponse(
    res,
    400,
    'INVALID_REQUEST_BODY',
    'O body da requisiÃ§Ã£o nÃ£o pÃ´de ser processado.',
    err?.message || err,
    requestId
  );
});

app.listen(PORT, () => {
  console.log(`[tato-flash-worker] rodando na porta ${PORT}`);
  console.log(`[tato-flash-worker] modelo: ${AGNES_MODEL}`);
  console.log(`[tato-flash-worker] upstream: ${AGNES_API_URL}`);
  console.log(`[tato-flash-worker] AGNES_API_KEY configurada: ${AGNES_API_KEY ? 'SIM' : 'NÃƒO'}`);
  console.log(`[tato-flash-worker] timeout upstream: ${REQUEST_TIMEOUT_MS}ms`);
});
