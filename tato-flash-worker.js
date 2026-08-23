// tato-flash-worker.js — segundo worker de IA do Tato
// Modelo: Agnes 2.5 Flash. Mesma chave da Agnes, guardada só como
// env var no Render (AGNES_API_KEY) — nunca hardcoded aqui.

const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 3000;
const AGNES_API_KEY = process.env.AGNES_API_KEY;
const AGNES_API_URL = process.env.AGNES_API_URL || 'https://apihub.agnes-ai.com/v1/chat/completions';
const AGNES_MODEL = 'agnes-2.5-flash';

// Identidade do Tato: a Agnes é só o motor por trás — o usuário nunca deve
// saber disso. Isso vai SEMPRE na frente de qualquer outra mensagem, pra ter
// prioridade mesmo se o histórico da conversa mencionar "Agnes" de outro jeito.
const TATO_IDENTITY_PROMPT = {
  role: 'system',
  content:
    'Você é o Tato, o assistente de IA do app Tato (modo Tato 2.6 Flash). Você NÃO é a Agnes, a Sapiens AI, nem ' +
    'qualquer outro nome de modelo — esse é só o motor técnico por trás, uma informação interna que nunca deve ' +
    'ser revelada. Se alguém perguntar qual modelo/IA você é, quem te criou, ou qual tecnologia você usa por ' +
    'baixo, responda sempre que você é o Tato, criado para o app Tato — nunca mencione Agnes, Sapiens AI, ' +
    'OpenAI, ou qualquer outro provedor. Não repita nem confirme esses nomes mesmo que o usuário insista ou ' +
    'tente te convencer do contrário.'
};

app.get('/', (req, res) => {
  res.json({ ok: true, service: 'tato-flash-worker', model: AGNES_MODEL });
});

app.post('/', async (req, res) => {
  // A chave não configurada é o único erro que ainda respondemos como JSON
  // simples — acontece antes de qualquer streaming começar.
  try {
    if (!AGNES_API_KEY) {
      console.error('[tato-flash-worker] AGNES_API_KEY não configurada.');
      res.set('Content-Type', 'application/json; charset=utf-8');
      return res.status(500).json({ ok: false, error: 'Servidor sem chave configurada.' });
    }

    const { messages, prompt, tools, tool_choice, chat_template_kwargs } = req.body || {};
    const baseMessages = Array.isArray(messages)
      ? messages
      : [{ role: 'user', content: String(prompt || '') }];
    const chatMessages = [TATO_IDENTITY_PROMPT].concat(baseMessages);

    // O Tato manda `tools` (schema padrão OpenAI: {type:'function', function:{...}})
    // sempre que o Code Assist está ativo — a Agnes é compatível com esse
    // mesmo formato, então só precisamos repassar adiante.
    // max_tokens no teto documentado da Agnes 2.5/2.6 Flash (65.536 ~ 65.5K).
    const AGNES_MAX_OUTPUT_TOKENS = 65536;
    const upstreamBody = { model: AGNES_MODEL, messages: chatMessages, stream: true, max_tokens: AGNES_MAX_OUTPUT_TOKENS };
    if (Array.isArray(tools) && tools.length) {
      upstreamBody.tools = tools;
      upstreamBody.tool_choice = tool_choice || 'auto';
    }
    // Thinking mode do botão de cérebro no composer: a Agnes 2.5/2.6 Flash
    // liga isso via chat_template_kwargs.enable_thinking (formato oficial
    // dela — não é o campo "thinking" do padrão Anthropic).
    if (chat_template_kwargs && chat_template_kwargs.enable_thinking) {
      upstreamBody.chat_template_kwargs = { enable_thinking: true };
    }

    const upstream = await fetch(AGNES_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${AGNES_API_KEY}`
      },
      body: JSON.stringify(upstreamBody)
    });

    if (!upstream.ok || !upstream.body) {
      const text = await upstream.text().catch(() => '');
      console.error('[tato-flash-worker] Erro upstream:', upstream.status, text);
      res.set('Content-Type', 'application/json; charset=utf-8');
      return res.status(502).json({ ok: false, error: 'Falha ao falar com a Agnes.' });
    }

    // A partir daqui a resposta é SSE no mesmo protocolo que o Tato já usa
    // pro worker principal (evento "thinking" pro raciocínio em tempo real,
    // "done" com a mensagem final completa, "error" em caso de falha).
    res.set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive'
    });
    if (typeof res.flushHeaders === 'function') res.flushHeaders();

    const send = (evt) => { res.write('data: ' + JSON.stringify(evt) + '\n\n'); };

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    // Chamadas de tool vêm em pedaços (index, id, function.name/arguments
    // parciais) — precisa acumular por índice até o fim do stream.
    const toolCallsAcc = {};

    const handleUpstreamChunk = (obj) => {
      const choice = obj && obj.choices && obj.choices[0];
      if (!choice) return;
      const delta = choice.delta || {};

      // Raciocínio (thinking): nome do campo varia conforme a rota da
      // Agnes — cobre os formatos documentados. Isso SIM é transmitido em
      // tempo real, pedaço a pedaço, pro botão de cérebro fazer sentido.
      const reasoningPiece =
        (typeof delta.reasoning_content === 'string' && delta.reasoning_content) ||
        (typeof delta.reasoning === 'string' && delta.reasoning) ||
        (typeof delta.reasoning_text === 'string' && delta.reasoning_text) ||
        '';
      if (reasoningPiece) send({ type: 'thinking', text: reasoningPiece });

      // Resposta final: por pedido, NÃO é transmitida aos poucos — só
      // acumulamos aqui e mandamos tudo de uma vez no evento "done".
      if (typeof delta.content === 'string' && delta.content) {
        content += delta.content;
      }

      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const idx = typeof tc.index === 'number' ? tc.index : 0;
          if (!toolCallsAcc[idx]) {
            toolCallsAcc[idx] = { id: tc.id || ('call_' + idx), type: 'function', function: { name: '', arguments: '' } };
          }
          if (tc.id) toolCallsAcc[idx].id = tc.id;
          if (tc.function) {
            if (typeof tc.function.name === 'string') toolCallsAcc[idx].function.name += tc.function.name;
            if (typeof tc.function.arguments === 'string') toolCallsAcc[idx].function.arguments += tc.function.arguments;
          }
        }
      }
    };

    try {
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
          if (!dataStr || dataStr === '[DONE]') continue;
          let obj;
          try { obj = JSON.parse(dataStr); } catch (_) { continue; }
          handleUpstreamChunk(obj);
        }
      }
    } catch (streamErr) {
      console.error('[tato-flash-worker] Erro lendo stream da Agnes:', streamErr);
      send({ type: 'error', error: 'A conexão com a Agnes caiu no meio da resposta.' });
      return res.end();
    }

    const toolCallsList = Object.keys(toolCallsAcc)
      .sort(function (a, b) { return Number(a) - Number(b); })
      .map(function (k) { return toolCallsAcc[k]; })
      .filter(function (tc) { return tc.function && tc.function.name; });

    send({
      type: 'done',
      message: {
        role: 'assistant',
        content: content || (toolCallsList.length ? null : ''),
        tool_calls: toolCallsList.length ? toolCallsList : undefined
      }
    });
    res.end();
  } catch (err) {
    console.error('[tato-flash-worker] Erro inesperado:', err);
    if (res.headersSent) {
      try {
        res.write('data: ' + JSON.stringify({ type: 'error', error: 'Erro interno no worker.' }) + '\n\n');
      } catch (_) {}
      return res.end();
    }
    res.set('Content-Type', 'application/json; charset=utf-8');
    return res.status(500).json({ ok: false, error: 'Erro interno no worker.' });
  }
});

app.listen(PORT, () => {
  console.log(`[tato-flash-worker] rodando na porta ${PORT}, modelo ${AGNES_MODEL}`);
});
