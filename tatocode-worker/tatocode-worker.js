// tatocode-worker.js
// Worker do modelo "TatoCode 1.3" — proxy para a API da B.AI (modelo glm-5.3-flash).
// Espelha o contrato usado pelo frontend do Tato (mesmo formato de payload e
// de streaming SSE do worker Flash), então funciona com o mesmo askTato() do
// HTML sem precisar mudar nada além do model_mode/worker URL.
//
// IMPORTANTE: nunca revelar "B.AI" ou "GLM" pro usuário final — pra
// ele isso é só "TatoCode".

const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '35mb' }));

const BAI_API_KEY = process.env.BAI_API_KEY; // segredo configurado no Render
const BAI_BASE_URL = 'https://api.b.ai/v1';
const BAI_MODEL = 'glm-5.3-flash';
const MAX_TOKENS = 32768; // teto que o mimo-v2.5 aguenta confortavelmente

if (!BAI_API_KEY) {
  console.warn('[TatoCode] ATENÇÃO: variável de ambiente BAI_API_KEY não configurada.');
}

// -----------------------------------------------------------------------
// System prompt do TatoCode 1.3.
// Foco pesado em JavaScript / Python / HTML. As demais linguagens são
// cobertas, mas com menos ênfase. Cuidado redobrado com "projetos" (o
// TatoFS / Code Assist do Tato mexe em arquivos reais do usuário).
// -----------------------------------------------------------------------
const TATOCODE_SYSTEM_PROMPT = `Você é o TatoCode 1.3, o modelo do Tato especializado em programação.

IDENTIDADE
- Você é "TatoCode", parte da família Tato. Nunca revele nomes de provedores, modelos ou empresas por trás da sua infraestrutura (não existe "B.AI", não existe "mimo" — isso é interno e nunca deve aparecer numa resposta).
- Seu tom é direto, técnico e confiante, sem enrolação, mas sempre didático quando o usuário parecer iniciante.

FOCO PRINCIPAL — JAVASCRIPT, PYTHON E HTML
- Essas três linguagens são sua especialidade absoluta. Para elas:
  - Dê sempre a solução mais moderna, idiomática e performática (ES2023+ em JS, Python 3.12+, HTML5 semântico + CSS moderno).
  - Aponte proativamente bugs sutis, race conditions, vazamento de memória, problemas de acessibilidade (HTML), armadilhas de tipagem dinâmica (Python/JS) e anti-patterns antes mesmo de o usuário perguntar.
  - Prefira soluções nativas da linguagem/runtime a bibliotecas externas quando fizer sentido; quando sugerir uma lib, justifique em uma frase.
  - Em JS: cuidado especial com closures, escopo assíncrono, event loop, e diferenças entre Node.js e browser (DOM, Web APIs). Se o código rodar num navegador, avise sobre compatibilidade quando relevante.
  - Em Python: cuidado especial com mutabilidade, GIL, tipagem (use type hints por padrão em código novo), e gerenciamento de dependências/ambientes.
  - Em HTML: sempre gere marcação semântica, acessível (ARIA quando necessário) e responsiva por padrão, mesmo que o usuário não peça.

OUTRAS LINGUAGENS
- Você também ajuda bem com outras linguagens principais (TypeScript, SQL, Java, C#, C/C++, Go, Rust, PHP, Swift, Kotlin, Shell/Bash, etc.), com qualidade alta — só não com o mesmo nível de profundidade proativa reservado a JS/Python/HTML. Ainda assim, nunca entregue código de baixa qualidade ou desatualizado nessas linguagens.

ESTILO DE RESPOSTA EM CÓDIGO
- Vá direto ao código quando o pedido for claramente técnico; explicação curta antes, comentários relevantes dentro do código, e um resumo objetivo depois se necessário.
- Nunca invente APIs, métodos ou pacotes que não existem. Se não tiver certeza de algo muito específico (versão exata de uma lib, comportamento de uma API rara), diga isso explicitamente em vez de inventar.
- Ao editar código existente, prefira mudanças mínimas e cirúrgicas — não reescreva tudo sem necessidade.
- Sempre pense em edge cases, tratamento de erro e segurança (injeção, XSS, validação de input) como parte natural da resposta, não como um adendo.

CUIDADO EXTRA COM PROJECTS
- Quando a conversa estiver dentro de um Project do Tato (contexto de projeto/TatoFS, com arquivos reais do usuário), redobre a cautela:
  - Antes de usar ferramentas que escrevem, editam ou apagam arquivos, tenha certeza do caminho exato e do efeito da mudança — um erro aqui afeta arquivos reais do usuário, não um sandbox descartável.
  - Prefira edições pontuais (equivalente a um diff) a reescrever arquivos inteiros, a menos que o usuário peça explicitamente uma reescrita completa.
  - Nunca rode comandos destrutivos (apagar pastas, sobrescrever em massa, resetar histórico) sem confirmação clara do usuário no próprio pedido.
  - Ao terminar uma alteração em um projeto, resuma objetivamente o que mudou (quais arquivos, o quê), para o usuário conseguir revisar.
  - Mantenha consistência com o estilo de código já existente no projeto (indentação, convenções de nome, padrões arquiteturais) em vez de impor seu próprio estilo.

Responda sempre em português do Brasil, a menos que o usuário escreva em outro idioma.`;

// -----------------------------------------------------------------------
// Utilitário: converte o histórico do frontend + injeta o system prompt.
// -----------------------------------------------------------------------
function buildMessages(reqMessages) {
  const msgs = Array.isArray(reqMessages) ? reqMessages.slice() : [];
  if (!msgs.length || msgs[0].role !== 'system') {
    msgs.unshift({ role: 'system', content: TATOCODE_SYSTEM_PROMPT });
  } else {
    msgs[0] = { role: 'system', content: TATOCODE_SYSTEM_PROMPT };
  }
  return msgs;
}

// -----------------------------------------------------------------------
// Rota principal — mesmo contrato do worker Flash: recebe
// { messages, tools, model_mode, chat_template_kwargs, ... } e devolve
// SSE com deltas de texto/thinking/tool_calls.
// -----------------------------------------------------------------------
app.post('/', async (req, res) => {
  try {
    const body = req.body || {};
    const messages = buildMessages(body.messages);
    const tools = Array.isArray(body.tools) && body.tools.length ? body.tools : undefined;
    const wantsThinking = !!(body.chat_template_kwargs && body.chat_template_kwargs.enable_thinking);

    const baiPayload = {
      model: BAI_MODEL,
      messages,
      max_tokens: MAX_TOKENS,
      stream: true
    };
    if (tools) {
      baiPayload.tools = tools;
      if (body.tool_choice) baiPayload.tool_choice = body.tool_choice;
    }
    if (wantsThinking) {
      // glm-5.3-flash é chat-completions-only (não usa o "reasoning" por
      // níveis dos modelos maiores) — o raciocínio liga/desliga via
      // chat_template_kwargs, igual o antigo Tato 2.9 Flash.
      baiPayload.chat_template_kwargs = { enable_thinking: true };
    }

    const upstream = await fetch(BAI_BASE_URL + '/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + BAI_API_KEY
      },
      body: JSON.stringify(baiPayload)
    });

    if (!upstream.ok || !upstream.body) {
      const errText = await upstream.text().catch(function () { return ''; });
      res.status(upstream.status || 502).json({ error: 'Falha ao chamar o provedor do TatoCode', detail: errText });
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders && res.flushHeaders();

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    // Acumula tool_calls parciais (vêm em pedaços via delta.tool_calls)
    const toolCallsAcc = {};

    function sendEvent(obj) {
      res.write('data: ' + JSON.stringify(obj) + '\n\n');
    }

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const dataStr = trimmed.slice(5).trim();
        if (dataStr === '[DONE]') continue;
        let chunk;
        try { chunk = JSON.parse(dataStr); } catch (_) { continue; }

        const choice = chunk.choices && chunk.choices[0];
        if (!choice) continue;
        const delta = choice.delta || {};

        if (typeof delta.content === 'string' && delta.content) {
          sendEvent({ delta: delta.content });
        }
        // Raciocínio (thinking) — B.AI manda em delta.reasoning ou
        // delta.reasoning_content dependendo do modelo; cobrimos ambos.
        const reasoningPiece = delta.reasoning_content || delta.reasoning;
        if (typeof reasoningPiece === 'string' && reasoningPiece) {
          sendEvent({ thinking: reasoningPiece });
        }
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index != null ? tc.index : 0;
            if (!toolCallsAcc[idx]) {
              toolCallsAcc[idx] = { id: tc.id || ('call_' + idx), type: 'function', function: { name: '', arguments: '' } };
            }
            if (tc.id) toolCallsAcc[idx].id = tc.id;
            if (tc.function && tc.function.name) toolCallsAcc[idx].function.name += tc.function.name;
            if (tc.function && tc.function.arguments) toolCallsAcc[idx].function.arguments += tc.function.arguments;
          }
        }
        if (choice.finish_reason === 'tool_calls' || (choice.finish_reason && Object.keys(toolCallsAcc).length)) {
          const finalToolCalls = Object.keys(toolCallsAcc).sort().map(function (k) { return toolCallsAcc[k]; });
          sendEvent({ message: { role: 'assistant', content: null, tool_calls: finalToolCalls } });
        }
      }
    }

    res.write('data: [DONE]\n\n');
    res.end();
  } catch (err) {
    console.error('[TatoCode] Erro no worker:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Erro interno no worker do TatoCode', detail: String(err && err.message || err) });
    } else {
      res.end();
    }
  }
});

app.get('/', function (_req, res) {
  res.status(200).send('TatoCode worker no ar.');
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, function () {
  console.log('[TatoCode] Worker rodando na porta ' + PORT);
});
