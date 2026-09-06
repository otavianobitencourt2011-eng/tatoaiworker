const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 10000;

// UnoRouter documenta o ID oficial como claude-opus-4-8.
// A variante :free é usada aqui exatamente como solicitada para o canal gratuito.
const MODEL = 'claude-opus-4-8:free';
const API_URL = 'https://api.unorouter.com/v1/chat/completions';
const MAX_OUTPUT_TOKENS = 128000;
const REASONING_EFFORT = 'medium';

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
      return part.text || part.content || part.value || '';
    }).join('');
  }
  if (value && typeof value === 'object') {
    return value.text || value.content || value.value || '';
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

function normalizeToolCall(call) {
  if (!call || typeof call !== 'object') return null;
  const fn = call.function || {};
  return {
    id: call.id || '',
    type: call.type || 'function',
    function: {
      name: fn.name || '',
      arguments: typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments || {})
    }
  };
}

function getReasoningText(delta, choice) {
  const candidates = [
    delta && delta.reasoning,
    delta && delta.reasoning_content,
    delta && delta.reasoning_summary,
    delta && delta.thinking,
    choice && choice.reasoning,
    choice && choice.reasoning_content,
    choice && choice.reasoning_summary,
    choice && choice.thinking
  ];

  for (const candidate of candidates) {
    const text = extractText(candidate);
    if (text) return text;
  }
  return '';
}

function collectReasoningFromMessage(message) {
  if (!message) return '';
  return extractText(
    message.reasoning ||
    message.reasoning_content ||
    message.reasoning_summary ||
    message.thinking ||
    ''
  );
}

function buildUpstreamBody(body) {
  const upstream = {
    model: MODEL,
    messages: Array.isArray(body.messages) ? body.messages : [],
    stream: true,
    reasoning_effort: REASONING_EFFORT,
    include_reasoning: true,
    max_tokens: MAX_OUTPUT_TOKENS
  };

  // O sistema do Tato envia as mesmas ferramentas para os workers.
  // O Tato Max simplesmente repassa essas tools ao UnoRouter.
  if (Array.isArray(body.tools) && body.tools.length) upstream.tools = body.tools;
  if (body.tool_choice !== undefined) upstream.tool_choice = body.tool_choice;
  if (body.response_format !== undefined) upstream.response_format = body.response_format;
  if (body.temperature !== undefined) upstream.temperature = body.temperature;
  if (body.top_p !== undefined) upstream.top_p = body.top_p;

  return upstream;
}

app.get('/', (_req, res) => {
  res.json({
    ok: true,
    worker: 'tato-max',
    model: MODEL,
    provider: 'UnoRouter',
    reasoning: REASONING_EFFORT,
    max_tokens: MAX_OUTPUT_TOKENS,
    context_window: 1000000,
    streaming: true,
    tools: true
  });
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, model: MODEL });
});

app.post('/', async (req, res) => {
  const apiKey = process.env.UNOROUTER_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      ok: false,
      error: 'UNOROUTER_API_KEY não configurada no Render.'
    });
  }

  const body = req.body || {};
  if (!Array.isArray(body.messages) || !body.messages.length) {
    return res.status(400).json({ ok: false, error: 'messages é obrigatório.' });
  }

  let upstream;
  try {
    upstream = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream'
      },
      body: JSON.stringify(buildUpstreamBody(body))
    });
  } catch (error) {
    return res.status(502).json({
      ok: false,
      error: `Falha ao conectar ao UnoRouter: ${error.message || error}`
    });
  }

  if (!upstream.ok) {
    const raw = await upstream.text().catch(() => '');
    let payload = null;
    try { payload = raw ? JSON.parse(raw) : null; } catch (_) {}
    return res.status(upstream.status).json({
      ok: false,
      error: getErrorMessage(payload, raw || `UnoRouter HTTP ${upstream.status}`),
      upstream_status: upstream.status
    });
  }

  if (!upstream.body) {
    return res.status(502).json({ ok: false, error: 'UnoRouter respondeu sem corpo.' });
  }

  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finalContent = '';
  let finalReasoning = '';
  const toolCalls = new Map();
  let finishReason = null;
  let sentDone = false;

  function mergeToolDelta(index, deltaTool) {
    const idx = Number.isInteger(index) ? index : 0;
    const existing = toolCalls.get(idx) || {
      id: '',
      type: 'function',
      function: { name: '', arguments: '' }
    };

    if (deltaTool.id) existing.id = deltaTool.id;
    if (deltaTool.type) existing.type = deltaTool.type;
    if (deltaTool.function) {
      if (deltaTool.function.name) existing.function.name += deltaTool.function.name;
      if (typeof deltaTool.function.arguments === 'string') existing.function.arguments += deltaTool.function.arguments;
    }

    toolCalls.set(idx, existing);
    return existing;
  }

  function processProviderObject(obj) {
    if (!obj) return;
    if (obj.error) {
      sendSse(res, { type: 'error', error: getErrorMessage(obj) });
      return;
    }

    const choices = Array.isArray(obj.choices) ? obj.choices : [];
    if (!choices.length) {
      // Alguns gateways devolvem uma mensagem completa em vez de choices delta.
      const msg = obj.message || obj;
      const reasoning = collectReasoningFromMessage(msg);
      if (reasoning) {
        finalReasoning += reasoning;
        sendSse(res, { type: 'thinking', text: reasoning });
      }
      const content = extractText(msg.content || obj.content || obj.reply || '');
      if (content) {
        finalContent += content;
        sendSse(res, { type: 'delta', text: content });
      }
      if (Array.isArray(msg.tool_calls)) {
        msg.tool_calls.forEach((call, i) => {
          const normalized = normalizeToolCall(call);
          if (!normalized) return;
          toolCalls.set(i, normalized);
          sendSse(res, {
            type: 'tool_delta',
            index: i,
            name: normalized.function.name,
            arguments: normalized.function.arguments
          });
        });
      }
      return;
    }

    const choice = choices[0] || {};
    const delta = choice.delta || choice.message || {};

    const reasoning = getReasoningText(delta, choice);
    if (reasoning) {
      finalReasoning += reasoning;
      sendSse(res, { type: 'thinking', text: reasoning });
    }

    const content = extractText(delta.content);
    if (content) {
      finalContent += content;
      sendSse(res, { type: 'delta', text: content });
    }

    const deltas = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
    for (const toolDelta of deltas) {
      const idx = Number.isInteger(toolDelta.index) ? toolDelta.index : 0;
      const merged = mergeToolDelta(idx, toolDelta);
      sendSse(res, {
        type: 'tool_delta',
        index: idx,
        name: merged.function.name,
        arguments: toolDelta.function && typeof toolDelta.function.arguments === 'string'
          ? toolDelta.function.arguments
          : ''
      });
    }

    if (choice.finish_reason) finishReason = choice.finish_reason;
  }

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const rawEvent = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);

        const dataLines = rawEvent
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trim());

        for (const data of dataLines) {
          if (!data || data === '[DONE]') continue;
          let parsed;
          try { parsed = JSON.parse(data); } catch (_) { continue; }
          processProviderObject(parsed);
        }
      }
    }

    // Tenta processar um último evento sem \n\n, caso o gateway finalize assim.
    const trailing = buffer.trim();
    if (trailing.startsWith('data:')) {
      const data = trailing.slice(5).trim();
      if (data && data !== '[DONE]') {
        try { processProviderObject(JSON.parse(data)); } catch (_) {}
      }
    }

    const message = {
      role: 'assistant',
      content: finalContent,
      tool_calls: Array.from(toolCalls.entries())
        .sort((a, b) => a[0] - b[0])
        .map(([, call]) => normalizeToolCall(call))
        .filter(Boolean)
    };

    if (!message.tool_calls.length) delete message.tool_calls;
    if (finalReasoning) message.reasoning_summary = finalReasoning;

    sendSse(res, {
      type: 'done',
      message,
      finish_reason: finishReason,
      limitReached: finishReason === 'length',
      reasoningCheckpoint: false
    });
    sentDone = true;
  } catch (error) {
    sendSse(res, { type: 'error', error: error.message || String(error) });
  } finally {
    if (!sentDone) {
      try { sendSse(res, { type: 'error', error: 'A conexão com o UnoRouter foi encerrada antes da conclusão.' }); } catch (_) {}
    }
    res.end();
  }
});

app.listen(PORT, () => {
  console.log(`[Tato Max] Worker ouvindo na porta ${PORT}`);
  console.log(`[Tato Max] Modelo: ${MODEL}`);
  console.log(`[Tato Max] Reasoning: ${REASONING_EFFORT} | max_tokens: ${MAX_OUTPUT_TOKENS}`);
});
