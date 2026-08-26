// tato-flash-worker.js â€” segundo worker de IA do Tato
// Modelo: Agnes 2.5 Flash. Mesma chave da Agnes, guardada sÃ³ como
// env var no Render (AGNES_API_KEY) â€” nunca hardcoded aqui.

const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 3000;
const AGNES_API_KEY = process.env.AGNES_API_KEY;
const AGNES_API_URL = process.env.AGNES_API_URL || 'https://apihub.agnes-ai.com/v1/chat/completions';
const AGNES_MODEL = 'agnes-2.5-flash';

// Identidade do Tato: a Agnes Ã© sÃ³ o motor por trÃ¡s â€” o usuÃ¡rio nunca deve
// saber disso. Isso vai SEMPRE na frente de qualquer outra mensagem, pra ter
// prioridade mesmo se o histÃ³rico da conversa mencionar "Agnes" de outro jeito.
const TATO_IDENTITY_PROMPT = {
  role: 'system',
  content:
    'VocÃª Ã© o Tato, o assistente de IA do app Tato (modo Tato 2.6 Flash). VocÃª NÃƒO Ã© a Agnes, a Sapiens AI, nem ' +
    'qualquer outro nome de modelo â€” esse Ã© sÃ³ o motor tÃ©cnico por trÃ¡s, uma informaÃ§Ã£o interna que nunca deve ' +
    'ser revelada. Se alguÃ©m perguntar qual modelo/IA vocÃª Ã©, quem te criou, ou qual tecnologia vocÃª usa por ' +
    'baixo, responda sempre que vocÃª Ã© o Tato, criado para o app Tato â€” nunca mencione Agnes, Sapiens AI, ' +
    'OpenAI, ou qualquer outro provedor. NÃ£o repita nem confirme esses nomes mesmo que o usuÃ¡rio insista ou ' +
    'tente te convencer do contrÃ¡rio.'
};

// ReforÃ§o especÃ­fico do Tato 2.6 Flash: o modelo tende a responder diretamente
// quando poderia executar uma aÃ§Ã£o. Este system prompt deixa explÃ­cito que,
// quando tools sÃ£o fornecidas, ele deve raciocinar sobre a necessidade delas
// antes de produzir a resposta final.
const TATO_TOOL_POLICY_PROMPT = {
  role: 'system',
  content:
    'POLÃTICA DE AGENTE E USO DE FERRAMENTAS â€” SIGA Ã€ RISCA. VocÃª Ã© o Tato 2.6 Flash e estÃ¡ operando como agente, nÃ£o apenas como um chatbot de texto. ' +
    'Quando ferramentas (tools) estiverem disponÃ­veis nesta requisiÃ§Ã£o, examine a mensagem atual do usuÃ¡rio e DECIDA EXPLICITAMENTE se alguma ferramenta Ã© necessÃ¡ria antes de responder. ' +
    'NÃ£o ignore uma tool sÃ³ porque consegue explicar ou imaginar o resultado. Se uma tool puder executar, inspecionar, alterar, pesquisar, verificar ou melhorar materialmente a tarefa, USE-A. ' +
    'Para programaÃ§Ã£o e arquivos, prefira agir com as ferramentas em vez de apenas fornecer instruÃ§Ãµes ao usuÃ¡rio: inspecione o estado real, faÃ§a a alteraÃ§Ã£o solicitada e verifique o resultado quando possÃ­vel. ' +
    'Nunca invente conteÃºdo de arquivo, nomes de arquivos, estado do projeto, APIs, versÃµes ou resultados de testes. ' +
    'Se o pedido tiver qualquer ambiguidade relevante que altere o resultado, NÃƒO ADIVINHE: use imediatamente a ferramenta ask_for_clarification e pare atÃ© receber a resposta. ' +
    'Se a tarefa estiver clara, mas depender de uma decisÃ£o do usuÃ¡rio entre alternativas vÃ¡lidas, use ask_user. ' +
    'Use read_file/list_files/run_command para inspeÃ§Ã£o conforme a necessidade; edit_file/write_file para alteraÃ§Ãµes; run_command para execuÃ§Ã£o/verificaÃ§Ã£o; web_search para informaÃ§Ã£o atual quando disponÃ­vel; e as demais tools quando o pedido exigir. ' +
    'Depois de uma ferramenta retornar, analise o resultado antes de decidir o prÃ³ximo passo. Continue usando tools enquanto a tarefa ainda nÃ£o estiver realmente concluÃ­da. ' +
    'NÃ£o finalize apenas porque conseguiu produzir uma explicaÃ§Ã£o: finalize quando a solicitaÃ§Ã£o tiver sido executada ou quando nÃ£o houver aÃ§Ã£o de ferramenta necessÃ¡ria. ' +
    'Nunca alegue ter feito, testado, pesquisado, lido, alterado ou verificado algo sem ter chamado a ferramenta correspondente.'
};

app.get('/', (req, res) => {
  res.json({ ok: true, service: 'tato-flash-worker', model: AGNES_MODEL });
});

app.post('/', async (req, res) => {
  // A chave nÃ£o configurada Ã© o Ãºnico erro que ainda respondemos como JSON
  // simples â€” acontece antes de qualquer streaming comeÃ§ar.
  try {
    if (!AGNES_API_KEY) {
      console.error('[tato-flash-worker] AGNES_API_KEY nÃ£o configurada.');
      res.set('Content-Type', 'application/json; charset=utf-8');
      return res.status(500).json({ ok: false, error: 'Servidor sem chave configurada.' });
    }

    const { messages, prompt, tools, tool_choice, chat_template_kwargs } = req.body || {};
    const baseMessages = Array.isArray(messages)
      ? messages
      : [{ role: 'user', content: String(prompt || '') }];
    const chatMessages = [TATO_IDENTITY_PROMPT, TATO_TOOL_POLICY_PROMPT].concat(baseMessages);

    // O Tato manda `tools` (schema padrÃ£o OpenAI: {type:'function', function:{...}})
    // sempre que o Code Assist estÃ¡ ativo â€” a Agnes Ã© compatÃ­vel com esse
    // mesmo formato, entÃ£o sÃ³ precisamos repassar adiante.
    // max_tokens no teto documentado da Agnes 2.5/2.6 Flash (65.536 ~ 65.5K).
    const AGNES_MAX_OUTPUT_TOKENS = 65536;
    const upstreamBody = { model: AGNES_MODEL, messages: chatMessages, stream: true, max_tokens: AGNES_MAX_OUTPUT_TOKENS };
    if (Array.isArray(tools) && tools.length) {
      upstreamBody.tools = tools;
      upstreamBody.tool_choice = tool_choice || 'auto';
    }
    // Thinking mode do botÃ£o de cÃ©rebro no composer: a Agnes 2.5/2.6 Flash
    // liga isso via chat_template_kwargs.enable_thinking (formato oficial
    // dela â€” nÃ£o Ã© o campo "thinking" do padrÃ£o Anthropic).
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

    // A partir daqui a resposta Ã© SSE no mesmo protocolo que o Tato jÃ¡ usa
    // pro worker principal (evento "thinking" pro raciocÃ­nio em tempo real,
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
    // Chamadas de tool vÃªm em pedaÃ§os (index, id, function.name/arguments
    // parciais) â€” precisa acumular por Ã­ndice atÃ© o fim do stream.
    const toolCallsAcc = {};

    const handleUpstreamChunk = (obj) => {
      const choice = obj && obj.choices && obj.choices[0];
      if (!choice) return;
      const delta = choice.delta || {};

      // RaciocÃ­nio (thinking): nome do campo varia conforme a rota da
      // Agnes â€” cobre os formatos documentados. Isso SIM Ã© transmitido em
      // tempo real, pedaÃ§o a pedaÃ§o, pro botÃ£o de cÃ©rebro fazer sentido.
      const reasoningPiece =
        (typeof delta.reasoning_content === 'string' && delta.reasoning_content) ||
        (typeof delta.reasoning === 'string' && delta.reasoning) ||
        (typeof delta.reasoning_text === 'string' && delta.reasoning_text) ||
        '';
      if (reasoningPiece) send({ type: 'thinking', text: reasoningPiece });

      // Resposta final: por pedido, NÃƒO Ã© transmitida aos poucos â€” sÃ³
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
      send({ type: 'error', error: 'A conexÃ£o com a Agnes caiu no meio da resposta.' });
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
