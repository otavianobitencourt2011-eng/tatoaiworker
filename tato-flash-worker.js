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
  res.set('Content-Type', 'application/json; charset=utf-8');
  try {
    if (!AGNES_API_KEY) {
      console.error('[tato-flash-worker] AGNES_API_KEY não configurada.');
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
    const upstreamBody = { model: AGNES_MODEL, messages: chatMessages, stream: false, max_tokens: AGNES_MAX_OUTPUT_TOKENS };
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

    if (!upstream.ok) {
      const text = await upstream.text().catch(() => '');
      console.error('[tato-flash-worker] Erro upstream:', upstream.status, text);
      return res.status(502).json({ ok: false, error: 'Falha ao falar com a Agnes.' });
    }

    const data = await upstream.json();
    const message = data?.choices?.[0]?.message || {};
    const toolCalls = Array.isArray(message.tool_calls) && message.tool_calls.length
      ? message.tool_calls
      : null;
    // O raciocínio (thinking) pode vir em campos diferentes dependendo da
    // versão/rota da Agnes — cobre os formatos documentados.
    const reasoning =
      message.reasoning_content ||
      message.reasoning ||
      (Array.isArray(message.content) && message.content.find(function (c) { return c && c.type === 'reasoning_text'; })?.reasoning_text) ||
      null;

    // Quando o modelo pede pra chamar uma tool, o Tato espera receber a
    // mensagem inteira (com tool_calls) e não só um texto — sem isso o
    // Code Assist nunca sabe que precisa executar read_file/write_file/etc.
    if (toolCalls) {
      return res.json({
        ok: true,
        message: { role: 'assistant', content: message.content || null, tool_calls: toolCalls },
        thinking: reasoning || undefined
      });
    }

    const reply = message.content ?? data?.reply ?? data?.output_text ?? '';
    return res.json({ ok: true, reply, thinking: reasoning || undefined });
  } catch (err) {
    console.error('[tato-flash-worker] Erro inesperado:', err);
    return res.status(500).json({ ok: false, error: 'Erro interno no worker.' });
  }
});

app.listen(PORT, () => {
  console.log(`[tato-flash-worker] rodando na porta ${PORT}, modelo ${AGNES_MODEL}`);
});
