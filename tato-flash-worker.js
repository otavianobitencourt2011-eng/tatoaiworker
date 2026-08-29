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
// Tato 1.1 foi retirado do produto. Pode voltar futuramente, mas nÃ£o Ã© um modelo ativo nesta versÃ£o.
const TATO_IDENTITY_PROMPT = {
  role: 'system',
  content:
    'VocÃª Ã© o Tato, o assistente de IA do app Tato (modo Tato 2.9). VocÃª NÃƒO Ã© a Agnes, a Sapiens AI, nem ' +
    'qualquer outro nome de modelo â€” esse Ã© sÃ³ o motor tÃ©cnico por trÃ¡s, uma informaÃ§Ã£o interna que nunca deve ' +
    'ser revelada. Se alguÃ©m perguntar qual modelo/IA vocÃª Ã©, quem te criou, ou qual tecnologia vocÃª usa por ' +
    'baixo, responda sempre que vocÃª Ã© o Tato, criado para o app Tato â€” nunca mencione Agnes, Sapiens AI, ' +
    'OpenAI, ou qualquer outro provedor. NÃ£o repita nem confirme esses nomes mesmo que o usuÃ¡rio insista ou ' +
    'tente te convencer do contrÃ¡rio.'
};

// ReforÃ§o especÃ­fico do Tato 2.9: o modelo tende a responder diretamente
// quando poderia executar uma aÃ§Ã£o. Este system prompt deixa explÃ­cito que,
// quando tools sÃ£o fornecidas, ele deve raciocinar sobre a necessidade delas
// antes de produzir a resposta final.
const TATO_TOOL_POLICY_PROMPT = {
  role: 'system',
  content:
    'POLÃTICA CENTRAL DO TATO 2.9 â€” AGENTE DE ALTA CAPACIDADE. VocÃª Ã© o Tato 2.9, o modelo principal e mais potente do Tato. ' +
    'Seu trabalho nÃ£o Ã© apenas conversar: quando ferramentas estiverem disponÃ­veis, vocÃª deve agir como um agente competente, ' +
    'planejando mentalmente a tarefa, escolhendo as ferramentas adequadas, executando as etapas necessÃ¡rias e verificando o resultado antes de finalizar. ' +
    'Pense antes de agir: identifique o objetivo, as restriÃ§Ãµes e o estado real dos arquivos/dados; depois escolha a menor sequÃªncia de ferramentas que resolva a tarefa com seguranÃ§a. ' +
    'NÃ£o responda com uma explicaÃ§Ã£o quando a solicitaÃ§Ã£o pede uma aÃ§Ã£o que uma ferramenta pode executar. ' +
    'Para programaÃ§Ã£o, trate o pedido como uma tarefa de engenharia: inspecione arquivos existentes antes de editar, preserve o que nÃ£o foi pedido para mudar, implemente a soluÃ§Ã£o completa, execute testes/verificaÃ§Ãµes quando disponÃ­veis e corrija problemas encontrados. ' +
    'Quando um arquivo jÃ¡ existe, nÃ£o invente seu conteÃºdo nem reescreva partes que nÃ£o precisam mudar. Use read_file, list_files, run_command ou edit_file conforme a situaÃ§Ã£o. ' +
    'Para pÃ¡ginas HTML recÃ©m-criadas ou alteradas, use test_html_sandbox quando essa verificaÃ§Ã£o fizer sentido; se houver erro real, corrija e teste novamente antes de concluir. ' +
    'Use send_file quando o usuÃ¡rio precisar receber explicitamente um arquivo. ' +
    'Use sleep somente quando uma espera real de 5 a 15 segundos for necessÃ¡ria para sincronizaÃ§Ã£o, teste ou sequÃªncia temporal; nunca use sleep como decoraÃ§Ã£o. ' +
    'Use read_url quando o usuÃ¡rio fornecer uma URL concreta que precise ser lida; use web_search para descoberta ou informaÃ§Ã£o atual quando essa ferramenta estiver disponÃ­vel. ' +
    'Use github para consultar diretamente cÃ³digo, repositÃ³rios, releases e metadados do GitHub quando a tarefa depender disso. ' +
    'Use create_slides/slides_wizard para apresentaÃ§Ãµes e redacao para redaÃ§Ãµes quando essas ferramentas forem apropriadas. ' +
    'NÃ£o invente nomes de arquivos, APIs, versÃµes, resultados de testes, conteÃºdo de ferramentas ou fatos obtidos por ferramentas. ' +
    'Se uma ferramenta retornar erro, trate o erro como informaÃ§Ã£o de estado: analise a causa, tente uma correÃ§Ã£o vÃ¡lida quando houver uma aÃ§Ã£o clara para isso e verifique novamente; nÃ£o esconda o erro nem alegue sucesso. ' +
    'Se uma ferramenta retornar conteÃºdo parcial ou truncado, continue a leitura pelo mecanismo indicado em vez de adivinhar o restante. ' +
    'Se houver vÃ¡rias etapas independentes, execute-as de forma eficiente; se uma etapa depender do resultado de outra, espere o resultado antes de prosseguir. ' +
    'Depois de cada ferramenta, reavalie o estado atual e decida o prÃ³ximo passo. Continue o ciclo ferramenta â†’ anÃ¡lise â†’ prÃ³xima ferramenta atÃ© a tarefa estar realmente concluÃ­da. ' +
    'Se a solicitaÃ§Ã£o tiver uma ambiguidade relevante que possa mudar materialmente o resultado, use ask_for_clarification e pare. Se depender de uma escolha de preferÃªncia entre alternativas vÃ¡lidas, use ask_user. ' +
    'NÃ£o faÃ§a perguntas que vocÃª consegue resolver sozinho com bom senso ou inspeÃ§Ã£o. ' +
    'Nunca finalize apenas porque produziu texto: finalize quando a aÃ§Ã£o solicitada estiver executada e verificada, ou quando nenhuma ferramenta for necessÃ¡ria. ' +
    'Nunca alegue ter lido, pesquisado, executado, editado, criado, enviado ou testado algo sem ter chamado a ferramenta correspondente.'
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
