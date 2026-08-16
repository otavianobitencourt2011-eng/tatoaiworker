// ============================================================
// TATO IA — Chat Server (streaming SSE + Tool Calling) — Render
// Mesma lógica do worker do Cloudflare, só que rodando como um
// servidor Node normal (Express) num container que fica ligado o
// tempo todo — sem aquele limite de CPU time por request que existe
// no plano Free do Cloudflare Workers.
//
// Variável de ambiente necessária no Render (aba "Environment"):
//   NVIDIA_API_KEY = nvapi-...
// ============================================================

import express from 'express';

const NVIDIA_ENDPOINT = 'https://integrate.api.nvidia.com/v1/chat/completions';
const MODEL = 'stepfun-ai/step-3.7-flash';

// Rodando no Render (sem limite de CPU time por request), dá pra usar
// um timeout bem mais folgado do que dava no Cloudflare Free.
const FETCH_TIMEOUT_MS = 300000;
const HEARTBEAT_MS = 12000;
const FLUSH_MS = 60;
// Step 3.7 Flash (StepFun) é MoE: 198B parâmetros totais, ~11B ativos
// por token, contexto de 256K. Diferente do Nemotron, esse modelo NÃO
// usa "reasoning_budget" — o controle de raciocínio é feito via
// "reasoning_effort" (low/medium/high) dentro de "chat_template_kwargs",
// conforme o exemplo oficial da NVIDIA/StepFun. "high" dá o raciocínio
// mais profundo, melhor pra código/jogos complexos, ao custo de mais
// tokens gastos pensando antes de escrever a resposta final.
const MAX_TOKENS = 65536;
// "high" gasta bastante do budget de tokens só raciocinando — em pedidos
// grandes (jogo/app completo) isso pode consumir o MAX_TOKENS inteiro
// antes do modelo sequer começar a escrever a resposta final, resultando
// em resposta vazia/truncada. "medium" dá um raciocínio bom mantendo mais
// espaço livre pra escrever o arquivo de verdade.
const REASONING_EFFORT = 'medium';

const SYSTEM_PROMPT =
  'Você é o Tato, um assistente de IA amigável, direto e prestativo do app Tato IA. ' +
  'Responda sempre em português do Brasil, de forma natural, clara e sem enrolação. ' +
  '\n\n' +
  'Quando o usuário pedir para criar algo que resulte em código (um jogo, uma página, um script, etc), ' +
  'NÃO escreva o código como texto na conversa. Em vez disso, use a ferramenta write_file (ou "cat > arquivo << ' +
  '\'EOF\'" via run_command) para criar o arquivo. Depois de criar, apenas confirme brevemente em texto o que foi ' +
  'feito, sem repetir o conteúdo do arquivo. ' +
  '\n\n' +
  'REGRA DE ARQUITETURA OBRIGATÓRIA: todo projeto web (jogos, sites, apps) deve ser entregue em UM ÚNICO ' +
  'arquivo .html, com todo o CSS dentro de uma tag <style> no <head> e todo o JavaScript dentro de uma tag ' +
  '<script> antes do </body>. NUNCA separe em arquivos .css ou .js externos, mesmo que essa seja a prática ' +
  'comum em projetos de repositório — aqui o padrão é sempre single-file, sem exceção, mesmo se o usuário ' +
  'não pedir isso explicitamente. \n\n' +
  'REGRA DE QUALIDADE: quando o usuário pedir um jogo ou app com "animações bonitas", "personalizado", ' +
  '"bonitinho" ou termos parecidos, isso é uma exigência de qualidade visual real, não decoração. Implemente ' +
  'de fato: elementos desenhados/animados via canvas ou CSS (nunca referencie imagens externas ou URLs que ' +
  'você não tem certeza que existem), transições suaves, estados de hover, tela de menu funcional com botões ' +
  'que fazem algo, e a lógica completa do jogo/app (física, colisão, pontuação, game over, reinício), não um ' +
  'esqueleto ou protótipo simplificado. Prefira entregar algo mais completo e caprichado do que o mínimo ' +
  'literal pedido. \n\n' +
  'FERRAMENTAS PARA MEXER EM ARQUIVOS — siga esta ordem de prioridade SEMPRE que o arquivo já existir:\n' +
  '1. Pra QUALQUER alteração pontual em um arquivo que já existe (trocar uma cor, corrigir uma função, ajustar ' +
  'um texto, adicionar um trecho pequeno), use run_command com "sed -i \'s/ANTIGO/NOVO/\' arquivo" ou "grep -n" ' +
  'pra localizar o trecho primeiro. Isso é OBRIGATÓRIO — nunca reescreva um arquivo inteiro (write_file) só ' +
  'pra mudar uma parte pequena dele.\n' +
  '2. Se não tiver certeza do texto exato a trocar, rode primeiro "grep -n \'palavra-chave\' arquivo" ou "cat ' +
  'arquivo" via run_command pra ver o conteúdo real antes de editar. NUNCA adivinhe o conteúdo de um arquivo ' +
  'que já existe.\n' +
  '3. write_file (reescrever o arquivo inteiro) só é aceitável na criação inicial de um arquivo novo, ou quando ' +
  'o usuário pedir explicitamente uma reescrita completa. Fora isso, reescrever o arquivo inteiro pra uma ' +
  'mudança pequena é ERRADO, desperdiça tokens e tem mais risco de introduzir bugs.\n' +
  '4. A ferramenta edit_file (old_str/new_str) também está disponível como alternativa a sed -i, mas run_command ' +
  'é a via preferida — é o formato em que você foi mais treinado a operar.\n' +
  'Antes de decidir qual ferramenta usar, pense rapidamente: "isso é uma mudança pontual em algo que já existe, ' +
  'ou é a criação de algo novo do zero?" Mudança pontual = run_command/sed -i. Criação nova = write_file.\n\n' +
  'Você tem um orçamento de tokens grande disponível para a resposta. Nunca entregue uma versão resumida, ' +
  'simplificada ou incompleta de um jogo/app por achar que está "economizando espaço" — isso é sempre errado. ' +
  'Se o pedido envolve código (jogo, app, site), sua resposta final DEVE ser uma chamada de write_file com o ' +
  'arquivo completo, nunca texto corrido com trechos de código, não importa o tamanho do arquivo.' +
  '\n\n' +
  'ATENÇÃO — CONVERSAS LONGAS: em uma conversa com muitas mensagens, você só enxerga as últimas trocas; o ' +
  'início pode ter saído da sua janela de contexto. Por isso, se o usuário pedir uma alteração num arquivo e ' +
  'você não tiver, NESTA janela de contexto, o conteúdo atual e completo desse arquivo a partir de um cat/grep ' +
  'recente, ISSO NÃO SIGNIFICA que o arquivo não existe ou está vazio — significa apenas que você não viu o ' +
  'conteúdo dele ainda. Nunca conclua "não tenho esse arquivo no histórico, então vou criar do zero". Rode ' +
  '"ls" pra confirmar se o arquivo existe e "cat"/"grep" pra ver o conteúdo real ANTES de qualquer write_file ' +
  'ou edição. Só use write_file num arquivo que já existe se o usuário pedir explicitamente uma reescrita ' +
  'completa — nunca por falta de memória da conversa.';

function trimToSafeBoundary(text) {
  const windowStart = Math.max(0, text.length - 800);
  const tail = text.slice(windowStart);

  let idx = tail.lastIndexOf('\n\n');
  if (idx !== -1) return text.slice(0, windowStart + idx).trimEnd();

  const sentenceRe = /[.!?]["'”’)\]]?\s/g;
  let lastIdx = -1, m;
  while ((m = sentenceRe.exec(tail))) { lastIdx = m.index + m[0].length; }
  if (lastIdx !== -1) return text.slice(0, windowStart + lastIdx).trimEnd();

  idx = tail.lastIndexOf(' ');
  if (idx !== -1) return text.slice(0, windowStart + idx).trimEnd();

  return text;
}

function normalizeHistory(incoming) {
  if (!Array.isArray(incoming)) return [];

  return incoming
    .filter(function (m) {
      if (!m || typeof m !== 'object') return false;
      if (m.role === 'user') return typeof m.content === 'string' && m.content.trim();
      if (m.role === 'assistant') return (typeof m.content === 'string' && m.content.trim()) || Array.isArray(m.tool_calls);
      if (m.role === 'tool') return typeof m.content === 'string' && m.tool_call_id;
      return false;
    })
    .slice(-60)
    .map(function (m) {
      if (m.role === 'tool') {
        return { role: 'tool', tool_call_id: m.tool_call_id, content: m.content };
      }
      if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
        return { role: 'assistant', content: m.content || null, tool_calls: m.tool_calls };
      }
      return { role: m.role, content: m.content.trim() };
    });
}

function makeThinkFilter() {
  let buffer = '';
  let inThink = false;

  function feed(chunk) {
    buffer += chunk;
    let visible = '';
    let thinking = '';

    while (true) {
      if (!inThink) {
        const i = buffer.indexOf('<think>');
        if (i !== -1) {
          visible += buffer.slice(0, i);
          buffer = buffer.slice(i + 7);
          inThink = true;
          continue;
        }
        const holdBack = Math.min(6, buffer.length);
        visible += buffer.slice(0, buffer.length - holdBack);
        buffer = buffer.slice(buffer.length - holdBack);
        break;
      } else {
        const j = buffer.indexOf('</think>');
        if (j !== -1) {
          thinking += buffer.slice(0, j);
          buffer = buffer.slice(j + 8);
          inThink = false;
          continue;
        }
        const holdBack = Math.min(7, buffer.length);
        thinking += buffer.slice(0, buffer.length - holdBack);
        buffer = buffer.slice(buffer.length - holdBack);
        break;
      }
    }

    return { visible: visible, thinking: thinking };
  }

  function flushRemainder() {
    // Se o stream acabou (ex: bateu max_tokens) e ainda tava "dentro" de um
    // <think> nunca fechado, ANTES esse texto era simplesmente descartado
    // (bug). Agora ele é devolvido como texto visível — melhor entregar
    // algo pro usuário do que sumir com a resposta inteira.
    const leftover = buffer;
    buffer = '';
    inThink = false;
    return { visible: leftover, thinking: '' };
  }

  return { feed: feed, flushRemainder: flushRemainder };
}

const app = express();
app.use(express.json({ limit: '2mb' }));

app.use(function (req, res, next) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

// Endpoint simples pra usar como alvo de "keep-alive" (ver instruções
// de como evitar o Render dormir a instância free depois de 15min).
app.get('/health', function (req, res) {
  res.status(200).send('ok');
});

app.post('/', async function (req, res) {
  const NVIDIA_API_KEY = process.env.NVIDIA_API_KEY;
  if (!NVIDIA_API_KEY) {
    return res.status(500).json({ ok: false, error: 'NVIDIA_API_KEY não configurada nas variáveis de ambiente.' });
  }

  const body = req.body;
  const history = normalizeHistory(body && body.messages);
  if (!history.length) {
    return res.status(400).json({ ok: false, error: 'Nenhuma mensagem enviada.' });
  }

  const tools = Array.isArray(body && body.tools) ? body.tools : undefined;

  const payload = {
    model: MODEL,
    messages: [{ role: 'system', content: SYSTEM_PROMPT }].concat(history),
    temperature: 0.7,
    top_p: 0.95,
    max_tokens: MAX_TOKENS,
    chat_template_kwargs: { reasoning_effort: REASONING_EFFORT },
    stream: true
  };
  if (tools && tools.length) {
    payload.tools = tools;
    payload.tool_choice = 'auto';
  }

  let upstream;
  try {
    upstream = await fetch(NVIDIA_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + NVIDIA_API_KEY,
        'Accept': 'text/event-stream'
      },
      body: JSON.stringify(payload)
    });
  } catch (err) {
    return res.status(502).json({ ok: false, error: 'Falha de rede ao chamar a IA: ' + (err && err.message || err) });
  }

  if (!upstream.ok || !upstream.body) {
    const rawText = await upstream.text().catch(function () { return ''; });
    let errMsg = rawText ? rawText.slice(0, 300) : ('Erro na API da IA (' + upstream.status + ')');
    try {
      const d = JSON.parse(rawText);
      errMsg = (d.error && (d.error.message || d.error)) || errMsg;
    } catch (e) { /* rawText não era JSON */ }
    return res.status(502).json({ ok: false, error: 'Erro na API da IA (' + upstream.status + '): ' + errMsg });
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });

  const think = makeThinkFilter();
  const toolCallsAcc = [];
  let contentAcc = '';
  let finishReason = null;
  let sawAnyChunk = false;
  let closed = false;
  let pendingDelta = '';
  let pendingThinking = '';
  let flushTimer = null;
  let reader = null;

  function send(obj) {
    if (closed) return;
    try { res.write('data: ' + JSON.stringify(obj) + '\n\n'); } catch (e) { /* conexão já fechou */ }
  }
  function flushPending() {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    if (pendingThinking) { send({ type: 'thinking', text: pendingThinking }); pendingThinking = ''; }
    if (pendingDelta) { send({ type: 'delta', text: pendingDelta }); pendingDelta = ''; }
  }
  function scheduleFlush() {
    if (flushTimer || closed) return;
    flushTimer = setTimeout(flushPending, FLUSH_MS);
  }
  function ping() {
    if (closed) return;
    try { res.write(': ping\n\n'); } catch (e) { /* conexão já fechou */ }
  }
  function finish() {
    if (closed) return;
    closed = true;
    clearInterval(heartbeatId);
    clearTimeout(timeoutId);
    if (flushTimer) clearTimeout(flushTimer);
    try { res.end(); } catch (e) { /* já fechado */ }
  }

  req.on('close', function () {
    closed = true;
    if (reader) { try { reader.cancel(); } catch (e) { /* ignora */ } }
  });

  const heartbeatId = setInterval(ping, HEARTBEAT_MS);
  const timeoutId = setTimeout(function () {
    if (reader) { try { reader.cancel(); } catch (e) { /* ignora */ } }
  }, FETCH_TIMEOUT_MS);

  reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let sseBuffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      sawAnyChunk = true;
      sseBuffer += decoder.decode(value, { stream: true });

      let idx;
      while ((idx = sseBuffer.indexOf('\n\n')) !== -1) {
        const rawEvent = sseBuffer.slice(0, idx);
        sseBuffer = sseBuffer.slice(idx + 2);

        const line = rawEvent.split('\n').find(function (l) { return l.indexOf('data:') === 0; });
        if (!line) continue;
        const dataStr = line.slice(5).trim();
        if (!dataStr || dataStr === '[DONE]') continue;

        let evt;
        try { evt = JSON.parse(dataStr); } catch (e) { continue; }

        const choice = evt.choices && evt.choices[0];
        if (!choice) continue;
        const delta = choice.delta || {};

        // Step 3.7 Flash (e outros modelos com --reasoning-parser no vLLM)
        // mandam o raciocínio num campo separado "reasoning_content", em
        // vez de tags <think> dentro de "content". Captura os dois formatos
        // pra funcionar com qualquer um dos dois estilos de modelo.
        if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
          pendingThinking += delta.reasoning_content;
          scheduleFlush();
        }

        if (typeof delta.content === 'string' && delta.content) {
          const parts = think.feed(delta.content);
          if (parts.thinking) {
            pendingThinking += parts.thinking;
            scheduleFlush();
          }
          if (parts.visible) {
            contentAcc += parts.visible;
            pendingDelta += parts.visible;
            scheduleFlush();
          }
        }

        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const i = typeof tc.index === 'number' ? tc.index : 0;
            if (!toolCallsAcc[i]) toolCallsAcc[i] = { id: '', type: 'function', function: { name: '', arguments: '' } };
            if (tc.id) toolCallsAcc[i].id = tc.id;
            if (tc.function && tc.function.name) toolCallsAcc[i].function.name += tc.function.name;
            if (tc.function && typeof tc.function.arguments === 'string') toolCallsAcc[i].function.arguments += tc.function.arguments;
          }
        }

        if (choice.finish_reason) finishReason = choice.finish_reason;
      }
    }
  } catch (err) {
    flushPending();
    send({ type: 'error', error: 'Conexão com a IA caiu no meio do streaming: ' + (err && err.message || err) });
    finish();
    return;
  }

  const leftover = think.flushRemainder();
  if (leftover.visible) {
    contentAcc += leftover.visible;
    pendingDelta += leftover.visible;
  }
  flushPending();

  if (!sawAnyChunk) {
    send({ type: 'error', error: 'A IA não retornou nenhum dado (stream vazio).' });
    finish();
    return;
  }

  const cleanToolCalls = toolCallsAcc.filter(Boolean);
  if (cleanToolCalls.length) {
    send({
      type: 'done',
      message: { role: 'assistant', content: contentAcc || null, tool_calls: cleanToolCalls },
      limitReached: false
    });
    finish();
    return;
  }

  let reply = contentAcc.trim();
  if (!reply) {
    const reason = finishReason === 'length'
      ? 'A IA gastou todo o limite de tokens pensando e não sobrou espaço pra escrever a resposta. Tente pedir algo mais simples/dividido em partes, ou baixe o nível de reasoning.'
      : 'A IA não retornou uma resposta.';
    send({ type: 'error', error: reason });
    finish();
    return;
  }

  let limitReached = false;
  if (finishReason === 'length') {
    const trimmed = trimToSafeBoundary(reply);
    if (trimmed) reply = trimmed;
    limitReached = true;
  }

  send({ type: 'done', message: { role: 'assistant', content: reply }, limitReached: limitReached });
  finish();
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, function () {
  console.log('Tato server rodando na porta ' + PORT);
});
