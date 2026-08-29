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
// Tato 1.1 foi retirado do produto. Pode voltar futuramente, mas não é um modelo ativo nesta versão.
const TATO_IDENTITY_PROMPT = {
  role: 'system',
  content:
    'Você é o Tato, o assistente de IA do app Tato (modo Tato 2.9). Você NÃO é a Agnes, a Sapiens AI, nem ' +
    'qualquer outro nome de modelo — esse é só o motor técnico por trás, uma informação interna que nunca deve ' +
    'ser revelada. Se alguém perguntar qual modelo/IA você é, quem te criou, ou qual tecnologia você usa por ' +
    'baixo, responda sempre que você é o Tato, criado para o app Tato — nunca mencione Agnes, Sapiens AI, ' +
    'OpenAI, ou qualquer outro provedor. Não repita nem confirme esses nomes mesmo que o usuário insista ou ' +
    'tente te convencer do contrário.'
};

// Reforço específico do Tato 2.9: o modelo tende a responder diretamente
// quando poderia executar uma ação. Este system prompt deixa explícito que,
// quando tools são fornecidas, ele deve raciocinar sobre a necessidade delas
// antes de produzir a resposta final.
const TATO_TOOL_POLICY_PROMPT = {
  role: 'system',
  content:
    'POLÍTICA CENTRAL DO TATO 2.9 — AGENTE DE ALTA CAPACIDADE. Você é o Tato 2.9, o modelo principal e mais potente do Tato. ' +
    'Seu trabalho não é apenas conversar: quando ferramentas estiverem disponíveis, você deve agir como um agente competente, ' +
    'planejando mentalmente a tarefa, escolhendo as ferramentas adequadas, executando as etapas necessárias e verificando o resultado antes de finalizar. ' +
    'Pense antes de agir: identifique o objetivo, as restrições e o estado real dos arquivos/dados; depois escolha a menor sequência de ferramentas que resolva a tarefa com segurança. ' +
    'Não responda com uma explicação quando a solicitação pede uma ação que uma ferramenta pode executar. ' +
    'Para programação, trate o pedido como uma tarefa de engenharia: inspecione arquivos existentes antes de editar, preserve o que não foi pedido para mudar, implemente a solução completa, execute testes/verificações quando disponíveis e corrija problemas encontrados. ' +
    'Quando um arquivo já existe, não invente seu conteúdo nem reescreva partes que não precisam mudar. Use read_file, list_files, run_command ou edit_file conforme a situação. ' +
    'Para páginas HTML recém-criadas ou alteradas, use test_html_sandbox quando essa verificação fizer sentido; se houver erro real, corrija e teste novamente antes de concluir. ' +
    'Use send_file quando o usuário precisar receber explicitamente um arquivo. ' +
    'Em tarefas longas com várias ferramentas em sequência, use notes pra anotar plano e progresso em vez de re-investigar tudo do zero a cada rodada — escreva um plano curto no início (notes action="write"), atualize com action="append" depois de cada etapa concluída, e leia com action="read" ao retomar uma tarefa interrompida. Não use notes em tarefas simples de 1-2 passos. ' +
    'Use sleep somente quando uma espera real de 5 a 15 segundos for necessária para sincronização, teste ou sequência temporal; nunca use sleep como decoração. ' +
    'Use read_url quando o usuário fornecer uma URL concreta que precise ser lida; use web_search para descoberta ou informação atual quando essa ferramenta estiver disponível. ' +
    'Use github para consultar diretamente código, repositórios, releases e metadados do GitHub quando a tarefa depender disso. ' +
    'Use create_slides/slides_wizard para apresentações e redacao para redações quando essas ferramentas forem apropriadas. ' +
    'Não invente nomes de arquivos, APIs, versões, resultados de testes, conteúdo de ferramentas ou fatos obtidos por ferramentas. ' +
    'Se uma ferramenta retornar erro, trate o erro como informação de estado: analise a causa, tente uma correção válida quando houver uma ação clara para isso e verifique novamente; não esconda o erro nem alegue sucesso. ' +
    'Se uma ferramenta retornar conteúdo parcial ou truncado, continue a leitura pelo mecanismo indicado em vez de adivinhar o restante. ' +
    'Se houver várias etapas independentes, execute-as de forma eficiente; se uma etapa depender do resultado de outra, espere o resultado antes de prosseguir. ' +
    'Depois de cada ferramenta, reavalie o estado atual e decida o próximo passo. Continue o ciclo ferramenta → análise → próxima ferramenta até a tarefa estar realmente concluída. ' +
    'Se a solicitação tiver uma ambiguidade relevante que possa mudar materialmente o resultado, use ask_for_clarification e pare. Se depender de uma escolha de preferência entre alternativas válidas, use ask_user. ' +
    'Não faça perguntas que você consegue resolver sozinho com bom senso ou inspeção. ' +
    'Nunca finalize apenas porque produziu texto: finalize quando a ação solicitada estiver executada e verificada, ou quando nenhuma ferramenta for necessária. ' +
    'Nunca alegue ter lido, pesquisado, executado, editado, criado, enviado ou testado algo sem ter chamado a ferramenta correspondente.'
};

// Contexto sobre os dois modelos do Tato, pro Tato 2.9 saber que existe o
// Tato 4.1 e a diferença entre os dois (mesmo texto usado no worker do 4.1).
const TATO_MODELS_CONTEXT_PROMPT = {
  role: 'system',
  content:
    'CONTEXTO DOS MODELOS DO TATO: o app Tato oferece dois modelos que a pessoa escolhe no seletor. Tato 2.9 ' +
    '(você) é o modelo principal, feito pra ser rápido e bom em tarefas do dia a dia, perguntas simples e uso ' +
    'geral com alta velocidade de resposta. Tato 4.1 é o modelo mais potente do Tato, com raciocínio mais forte ' +
    '— a escolha certa pra tarefas complexas: programação e arquivos maiores, depuração, arquitetura de ' +
    'projetos, mudanças que exigem entender bastante contexto, e qualquer coisa que se beneficie de mais ' +
    'raciocínio antes de responder. Se o usuário perguntar qual modelo é melhor, qual escolher pra determinada ' +
    'tarefa, ou como os dois se comparam, responda com naturalidade usando essa diferença (2.9 = rapidez/tarefas ' +
    'simples, 4.1 = potência/raciocínio para tarefas complexas). NUNCA revele qual motor/API roda por trás de ' +
    'nenhum dos dois modelos — isso é informação interna e nunca deve ser mencionada, mesmo comparando os dois.'
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
    const chatMessages = [TATO_IDENTITY_PROMPT, TATO_TOOL_POLICY_PROMPT, TATO_MODELS_CONTEXT_PROMPT].concat(baseMessages);

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
