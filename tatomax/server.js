const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 10000;

// Tato-5m: modelo dedicado Ã  geraÃ§Ã£o de imagens no UnoRouter.
const MODEL = 'gpt-image-2:free';
const API_URL = 'https://api.unorouter.com/v1/images/generations';

// gpt-image-2:free Ã© listado pelo UnoRouter como um modelo de image_generation
// com endpoint compatÃ­vel com OpenAI e preÃ§o $0.00/$0.00.
const DEFAULT_SIZE = process.env.IMAGE_SIZE || '1024x1024';
const DEFAULT_QUALITY = process.env.IMAGE_QUALITY || 'high';
const DEFAULT_N = Math.min(Math.max(Number(process.env.IMAGE_N || 1), 1), 8);

app.use(cors({
  origin: true,
  methods: ['POST', 'GET', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({ limit: '20mb' }));

function extractText(value) {
  if (typeof value === 'string') return value;

  if (Array.isArray(value)) {
    return value.map((part) => {
      if (typeof part === 'string') return part;
      if (!part || typeof part !== 'object') return '';
      return part.text || part.content || part.value || part.prompt || '';
    }).join('');
  }

  if (value && typeof value === 'object') {
    return value.text || value.content || value.value || value.prompt || '';
  }

  return '';
}

function getErrorMessage(payload, fallback = 'Erro desconhecido no UnoRouter.') {
  if (!payload) return fallback;
  if (typeof payload === 'string') return payload;

  if (payload.error) {
    if (typeof payload.error === 'string') return payload.error;
    if (typeof payload.error === 'object') {
      return payload.error.message || payload.error.detail || payload.error.code || JSON.stringify(payload.error);
    }
  }

  return payload.message || payload.detail || payload.reason || fallback;
}

function sendSse(res, event) {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function getPrompt(body) {
  if (typeof body.prompt === 'string' && body.prompt.trim()) {
    return body.prompt.trim();
  }

  if (!Array.isArray(body.messages)) return '';

  // Pega a Ãºltima mensagem do usuÃ¡rio para manter compatibilidade com o
  // formato que o frontend do Tato jÃ¡ envia para os outros workers.
  for (let i = body.messages.length - 1; i >= 0; i--) {
    const message = body.messages[i];
    if (!message || message.role !== 'user') continue;

    const text = extractText(message.content).trim();
    if (text) return text;
  }

  return '';
}

function getImageOptions(body) {
  const size = typeof body.size === 'string' && body.size.trim()
    ? body.size.trim()
    : DEFAULT_SIZE;

  const quality = typeof body.quality === 'string' && body.quality.trim()
    ? body.quality.trim()
    : DEFAULT_QUALITY;

  const nValue = Number(body.n ?? DEFAULT_N);
  const n = Number.isFinite(nValue)
    ? Math.min(Math.max(Math.floor(nValue), 1), 8)
    : DEFAULT_N;

  return { size, quality, n };
}

app.get('/', (_req, res) => {
  res.json({
    ok: true,
    worker: 'tato-5m',
    model: MODEL,
    provider: 'UnoRouter',
    mode: 'image_generation',
    endpoint: API_URL,
    size: DEFAULT_SIZE,
    quality: DEFAULT_QUALITY,
    max_images_per_request: 8
  });
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, model: MODEL, mode: 'image_generation' });
});

app.post('/', async (req, res) => {
  const apiKey = process.env.UNOROUTER_API_KEY;

  if (!apiKey) {
    return res.status(500).json({
      ok: false,
      error: 'UNOROUTER_API_KEY nÃ£o configurada no Render.'
    });
  }

  const body = req.body || {};
  const prompt = getPrompt(body);

  if (!prompt) {
    return res.status(400).json({
      ok: false,
      error: 'Envie um prompt em "prompt" ou uma mensagem de usuÃ¡rio em "messages".'
    });
  }

  const { size, quality, n } = getImageOptions(body);

  const upstreamBody = {
    model: MODEL,
    prompt,
    n,
    size,
    quality,
    response_format: 'b64_json'
  };

  let upstream;

  try {
    upstream = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify(upstreamBody)
    });
  } catch (error) {
    return res.status(502).json({
      ok: false,
      error: `Falha ao conectar ao UnoRouter: ${error.message || error}`
    });
  }

  const raw = await upstream.text().catch(() => '');
  let payload = null;
  try { payload = raw ? JSON.parse(raw) : null; } catch (_) {}

  if (!upstream.ok) {
    return res.status(upstream.status).json({
      ok: false,
      error: getErrorMessage(payload, raw || `UnoRouter HTTP ${upstream.status}`),
      upstream_status: upstream.status
    });
  }

  const images = Array.isArray(payload?.data) ? payload.data : [];

  if (!images.length) {
    return res.status(502).json({
      ok: false,
      error: 'O UnoRouter respondeu sem imagens.',
      upstream_response: payload || raw
    });
  }

  // Mantemos o mesmo contrato SSE dos outros workers do Tato para que o
  // frontend existente consiga consumir o resultado sem trocar o fluxo.
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  const imageUrls = [];

  for (const item of images) {
    if (item?.url) {
      imageUrls.push(item.url);
      continue;
    }

    if (item?.b64_json) {
      imageUrls.push(`data:image/png;base64,${item.b64_json}`);
    }
  }

  if (!imageUrls.length) {
    sendSse(res, {
      type: 'error',
      error: 'O UnoRouter retornou itens de imagem sem URL ou b64_json.'
    });
    res.end();
    return;
  }

  // Uma imagem por bloco markdown. O renderer atual do Tato pode exibir
  // markdown/data URLs e continua recebendo o evento final "done".
  const content = imageUrls
    .map((url, index) => `![Imagem gerada ${index + 1}](${url})`)
    .join('\n\n');

  sendSse(res, { type: 'delta', text: content });
  sendSse(res, {
    type: 'done',
    message: {
      role: 'assistant',
      content,
      images: imageUrls
    },
    finish_reason: 'stop',
    limitReached: false,
    reasoningCheckpoint: false
  });

  res.end();
});

app.listen(PORT, () => {
  console.log(`[Tato-5m] Worker ouvindo na porta ${PORT}`);
  console.log(`[Tato-5m] Modelo: ${MODEL}`);
  console.log(`[Tato-5m] Modo: image_generation`);
});
