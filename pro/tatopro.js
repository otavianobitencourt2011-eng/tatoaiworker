// tatopro.js
// Worker do Tato IA (Render) — fala com a TOKIA API (OpenAI-compatible)
// usando o modelo qwen3.7-flash, em streaming.
//
// Contrato de entrada (o que o front tato-2.html manda em POST /):
//   {
//     messages: [...],                 // formato OpenAI (role/content)
//     tools: [...],                    // definições de tool no formato OpenAI
//     lang: 'pt' | ...,
//     image_context: { state: 'guest' | 'authenticated_on' | 'authenticated_off' },
//     model_mode: 'tato-...' ,
//     tato_model_mode: 'tato-...',
//     chat_template_kwargs: { enable_thinking: true } // opcional
//   }
//
// Contrato de saída: SSE (Server-Sent Events), cada evento no formato
//   data: {"type": "...", ...}\n\n
// Tipos usados pelo front: delta, thinking, tool_delta, reasoning_checkpoint,
// done, error. Ver função askTato() em tato-2.html.

const express = require('express');
const cors = require('cors');

const PORT = process.env.PORT || 3000;
const TOKIA_API_KEY = process.env.TOKIA_API_KEY;
const TOKIA_API_URL = process.env.TOKIA_API_URL || 'https://api.usetokia.com/v1/chat/completions';
const TOKIA_MODEL = process.env.TOKIA_MODEL || 'qwen3.7-flash';
const MAX_TOKENS = Number(process.env.TOKIA_MAX_TOKENS || 4096);
const TEMPERATURE = process.env.TOKIA_TEMPERATURE !== undefined
  ? Number(process.env.TOKIA_TEMPERATURE)
  : 0.7;

if (!TOKIA_API_KEY) {
  console.warn('[tatopro] ATENÇÃO: variável de ambiente TOKIA_API_KEY não configurada. As requisições vão falhar com 401.');
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '25mb' }));

// Helper: escreve um evento SSE no formato que o front espera.
function sendEvent(res, payload) {
  res.write('data: ' + JSON.stringify(payload) + '\n\n');
}

// Helper: monta o system prompt do Tato a partir do idioma pedido.
function buildSystemPrompt(lang) {
  const isPt = !lang || String(lang).toLowerCase().startsWith('pt');
  if (isPt) {
    return 'Você é o Tato, um assistente de IA. Responda de forma direta, clara e útil, em português do Brasil, a menos que o usuário peça outro idioma.';
  }
  return 'You are Tato, an AI assistant. Respond clearly and helpfully in the language the user is using.';
}

app.get('/', function (req, res) {
  res.json({ ok: true, worker: 'tatopro', model: TOKIA_MODEL });
});

app.get('/health', function (req, res) {
  res.json({ status: 'ok' });
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
    messages: messages,
    stream: true,
    max_tokens: MAX_TOKENS,
    temperature: TEMPERATURE
  };
  if (tools.length) {
    tokiaPayload.tools = tools;
    tokiaPayload.tool_choice = 'auto';
  }
  // Qwen (via Tokia) usa esse campo pra ligar o "thinking" quando suportado.
  if (enableThinking) tokiaPayload.chat_template_kwargs = { enable_thinking: true };

  // Cabeçalhos de streaming pro cliente (front espera text/event-stream).
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });

  const controller = new AbortController();
  let upstreamFinished = false;

  // NÃO usar req.on('close') aqui: no Node/Express, o request pode emitir
  // 'close' após o body terminar de ser recebido, mesmo com o cliente ainda
  // esperando a resposta. Isso abortava a chamada à TOKIA imediatamente.
  req.on('aborted', function () {
    if (!upstreamFinished && !controller.signal.aborted) controller.abort();
  });

  res.on('close', function () {
    if (!upstreamFinished && !res.writableEnded && !controller.signal.aborted) {
      controller.abort();
    }
  });

  // Acumuladores pra montar a mensagem final no evento "done".
  let finalContent = '';
  let finalThinking = '';
  // toolCallsByIndex: { [index]: { id, type, function: { name, arguments } } }
  const toolCallsByIndex = {};
  let finishReason = null;

  try {
    const upstream = await fetch(TOKIA_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + TOKIA_API_KEY
      },
      body: JSON.stringify(tokiaPayload),
      signal: controller.signal
    });

    if (!upstream.ok || !upstream.body) {
      const rawErr = await upstream.text().catch(function () { return ''; });
      let parsedErr = null;
      try { parsedErr = rawErr ? JSON.parse(rawErr) : null; } catch (_) {}
      const msg = (parsedErr && parsedErr.error && (parsedErr.error.message || parsedErr.error.type))
        || rawErr
        || ('Falha ao falar com a TOKIA API (' + upstream.status + ')');
      sendEvent(res, { type: 'error', error: msg });
      res.end();
      return;
    }

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });

      let idx;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const rawEvent = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);

        const line = rawEvent.split('\n').find(function (l) { return l.indexOf('data:') === 0; });
        if (!line) continue;
        const dataStr = line.slice(5).trim();
        if (!dataStr) continue;
        if (dataStr === '[DONE]') continue;

        let evt;
        try { evt = JSON.parse(dataStr); } catch (e) { continue; }

        const choice = evt && evt.choices && evt.choices[0];
        if (!choice) continue;
        const delta = choice.delta || {};

        if (choice.finish_reason) finishReason = choice.finish_reason;

        // Texto normal da resposta.
        if (typeof delta.content === 'string' && delta.content) {
          finalContent += delta.content;
          sendEvent(res, { type: 'delta', text: delta.content });
        }

        // Raciocínio (thinking) — alguns providers Qwen mandam isso em
        // reasoning_content, seguindo a convenção do DeepSeek/Qwen.
        const reasoningPiece = delta.reasoning_content || delta.reasoning;
        if (typeof reasoningPiece === 'string' && reasoningPiece) {
          finalThinking += reasoningPiece;
          sendEvent(res, { type: 'thinking', text: reasoningPiece });
        }

        // Tool calls em streaming: cada pedaço chega com um "index" e vai
        // sendo concatenado até fechar a chamada.
        if (Array.isArray(delta.tool_calls)) {
          delta.tool_calls.forEach(function (tc) {
            const i = tc.index || 0;
            if (!toolCallsByIndex[i]) {
              toolCallsByIndex[i] = { id: tc.id || ('call_' + i), type: 'function', function: { name: '', arguments: '' } };
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
      }
    }

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
    upstreamFinished = true;
    res.end();
  } catch (error) {
    if (error && error.name === 'AbortError') {
      if (!res.writableEnded) {
        sendEvent(res, { type: 'error', error: 'A chamada à TOKIA foi interrompida antes de terminar.' });
        res.end();
      }
      return;
    }
    sendEvent(res, { type: 'error', error: (error && error.message) || 'Erro desconhecido no worker tatopro.' });
    res.end();
  }
});

app.listen(PORT, function () {
  console.log('[tatopro] worker no ar na porta ' + PORT + ' — modelo: ' + TOKIA_MODEL);
});
