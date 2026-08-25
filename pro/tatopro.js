// Tato Ultimate Worker — Render
// Gateway OpenAI-compatible -> TOKIA API, com streaming SSE e tool calling.

const express = require('express');
const cors = require('cors');

const PORT = process.env.PORT || 3000;
const TOKIA_API_KEY = process.env.TOKIA_API_KEY;
const TOKIA_API_URL = process.env.TOKIA_API_URL || 'https://api.usetokia.com/v1/chat/completions';
const TOKIA_MODEL = process.env.TOKIA_MODEL || 'test-free';
const MAX_TOKENS = Number(process.env.TOKIA_MAX_TOKENS || 4096);
const TEMPERATURE = process.env.TOKIA_TEMPERATURE !== undefined ? Number(process.env.TOKIA_TEMPERATURE) : 0.7;
const UPSTREAM_TIMEOUT_MS = Number(process.env.TOKIA_TIMEOUT_MS || 45000);
const HEARTBEAT_MS = 10000;

const app = express();
app.use(cors());
app.use(express.json({ limit: '25mb' }));

function sendEvent(res, payload) {
  if (res.writableEnded) return;
  res.write('data: ' + JSON.stringify(payload) + '\n\n');
}

function buildSystemPrompt(lang) {
  const isPt = !lang || String(lang).toLowerCase().startsWith('pt');
  return isPt
    ? 'Você é o Tato, um assistente de IA. Responda de forma direta, clara e útil, em português do Brasil, a menos que o usuário peça outro idioma.'
    : 'You are Tato, an AI assistant. Respond clearly and helpfully in the language the user is using.';
}

app.get('/', function (req, res) {
  res.json({ ok: true, worker: 'tatopro', model: TOKIA_MODEL });
});

app.get('/health', function (req, res) {
  res.json({ status: 'ok', worker: 'tatopro', model: TOKIA_MODEL });
});

app.post('/', async function (req, res) {
  const body = req.body || {};
  const incomingMessages = Array.isArray(body.messages) ? body.messages : [];
  const tools = Array.isArray(body.tools) ? body.tools.filter(Boolean) : [];
  const lang = body.lang;
  const enableThinking = !!(body.chat_template_kwargs && body.chat_template_kwargs.enable_thinking);

  if (!TOKIA_API_KEY) {
    res.status(500).json({ error: 'TOKIA_API_KEY não configurada no servidor.' });
    return;
  }

  const hasSystem = incomingMessages.some(function (m) { return m && m.role === 'system'; });
  const messages = hasSystem
    ? incomingMessages
    : [{ role: 'system', content: buildSystemPrompt(lang) }].concat(incomingMessages);

  const tokiaPayload = {
    model: TOKIA_MODEL,
    messages,
    stream: true,
    max_tokens: MAX_TOKENS,
    temperature: TEMPERATURE
  };

  if (tools.length) {
    tokiaPayload.tools = tools;
    tokiaPayload.tool_choice = 'auto';
  }

  if (enableThinking) {
    tokiaPayload.chat_template_kwargs = { enable_thinking: true };
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });

  const controller = new AbortController();
  let finished = false;

  function abortUpstream() {
    if (!finished && !controller.signal.aborted) controller.abort();
  }

  req.on('aborted', abortUpstream);
  res.on('close', function () {
    if (!finished && !res.writableEnded) abortUpstream();
  });

  // Mantém a conexão SSE ativa mesmo quando o provider demora para gerar o primeiro token.
  const heartbeat = setInterval(function () {
    if (!finished && !res.writableEnded) sendEvent(res, { type: 'heartbeat' });
  }, HEARTBEAT_MS);

  let finalContent = '';
  const toolCallsByIndex = {};
  let finishReason = null;

  try {
    const timeout = setTimeout(function () {
      controller.abort();
    }, UPSTREAM_TIMEOUT_MS);

    let upstream;
    try {
      upstream = await fetch(TOKIA_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'text/event-stream, application/json',
          Authorization: 'Bearer ' + TOKIA_API_KEY
        },
        body: JSON.stringify(tokiaPayload),
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!upstream.ok) {
      const raw = await upstream.text().catch(function () { return ''; });
      let parsed = null;
      try { parsed = raw ? JSON.parse(raw) : null; } catch (_) {}
      const msg = (parsed && parsed.error && (parsed.error.message || parsed.error.type))
        || (parsed && (parsed.message || parsed.detail))
        || raw
        || ('TOKIA HTTP ' + upstream.status);
      sendEvent(res, { type: 'error', error: String(msg) });
      return;
    }

    const contentType = String(upstream.headers.get('content-type') || '').toLowerCase();

    // Compatibilidade: se o provider responder JSON apesar de stream:true.
    if (contentType.indexOf('application/json') !== -1) {
      const raw = await upstream.text();
      let payload = {};
      try { payload = raw ? JSON.parse(raw) : {}; } catch (_) { payload = { reply: raw }; }
      if (payload.error) {
        sendEvent(res, { type: 'error', error: typeof payload.error === 'string' ? payload.error : JSON.stringify(payload.error) });
        return;
      }
      const msg = payload.message || (payload.choices && payload.choices[0] && payload.choices[0].message) || {};
      const reply = typeof msg.content === 'string' ? msg.content : (typeof payload.reply === 'string' ? payload.reply : '');
      const finalMessage = { role: 'assistant', content: reply };
      if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) finalMessage.tool_calls = msg.tool_calls;
      sendEvent(res, { type: 'done', message: finalMessage, limitReached: false, reasoningCheckpoint: false });
      return;
    }

    if (!upstream.body) {
      sendEvent(res, { type: 'error', error: 'TOKIA respondeu sem corpo de streaming.' });
      return;
    }

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let streamDone = false;

    function processSseEvent(rawEvent) {
      const normalized = rawEvent.replace(/\r/g, '');
      const dataLines = normalized.split('\n')
        .filter(function (line) { return line.indexOf('data:') === 0; })
        .map(function (line) { return line.slice(5).trimStart(); });

      if (!dataLines.length) return false;
      const dataStr = dataLines.join('\n').trim();
      if (!dataStr) return false;
      if (dataStr === '[DONE]') return true;

      let evt;
      try { evt = JSON.parse(dataStr); } catch (_) { return false; }
      const choice = evt && evt.choices && evt.choices[0];
      if (!choice) return false;

      const delta = choice.delta || {};
      if (choice.finish_reason) finishReason = choice.finish_reason;

      if (typeof delta.content === 'string' && delta.content) {
        finalContent += delta.content;
        sendEvent(res, { type: 'delta', text: delta.content });
      }

      const reasoningPiece = delta.reasoning_content || delta.reasoning;
      if (typeof reasoningPiece === 'string' && reasoningPiece) {
        sendEvent(res, { type: 'thinking', text: reasoningPiece });
      }

      if (Array.isArray(delta.tool_calls)) {
        delta.tool_calls.forEach(function (tc) {
          const i = Number.isInteger(tc.index) ? tc.index : 0;
          if (!toolCallsByIndex[i]) {
            toolCallsByIndex[i] = {
              id: tc.id || ('call_' + i),
              type: 'function',
              function: { name: '', arguments: '' }
            };
          }
          const entry = toolCallsByIndex[i];
          if (tc.id) entry.id = tc.id;
          if (tc.function && typeof tc.function.name === 'string') entry.function.name += tc.function.name;
          if (tc.function && typeof tc.function.arguments === 'string') entry.function.arguments += tc.function.arguments;
          sendEvent(res, {
            type: 'tool_delta',
            index: i,
            id: entry.id,
            name: tc.function && tc.function.name ? tc.function.name : undefined,
            arguments: tc.function && tc.function.arguments ? tc.function.arguments : undefined
          });
        });
      }
      return false;
    }

    while (!streamDone) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true }).replace(/\r\n/g, '\n');

      let idx;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const rawEvent = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        if (processSseEvent(rawEvent)) {
          streamDone = true;
          break;
        }
      }
    }

    if (!streamDone && buffer.trim()) processSseEvent(buffer);

    const toolCalls = Object.keys(toolCallsByIndex)
      .sort(function (a, b) { return Number(a) - Number(b); })
      .map(function (k) { return toolCallsByIndex[k]; });

    const finalMessage = { role: 'assistant', content: finalContent };
    if (toolCalls.length) finalMessage.tool_calls = toolCalls;

    sendEvent(res, {
      type: 'done',
      message: finalMessage,
      limitReached: finishReason === 'length',
      reasoningCheckpoint: false
    });
  } catch (error) {
    if (error && error.name === 'AbortError') {
      sendEvent(res, { type: 'error', error: 'A TOKIA não respondeu dentro do limite de 45 segundos ou a conexão foi interrompida.' });
    } else {
      sendEvent(res, { type: 'error', error: (error && error.message) || 'Erro desconhecido no worker.' });
    }
  } finally {
    finished = true;
    clearInterval(heartbeat);
    if (!res.writableEnded) res.end();
  }
});

app.listen(PORT, function () {
  console.log('[tatopro] worker no ar na porta ' + PORT + ' — modelo: ' + TOKIA_MODEL);
});
