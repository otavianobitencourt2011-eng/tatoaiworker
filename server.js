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
const FETCH_TIMEOUT_MS = 1200000; // 20 minutos (era 5 min — cortava em respostas longas/reescritas grandes)
const HEARTBEAT_MS = 12000;
const FLUSH_MS = 60;
// Step 3.7 Flash (StepFun) é MoE: 198B parâmetros totais, ~11B ativos
// por token, contexto de 256K. Diferente do Nemotron, esse modelo NÃO
// usa "reasoning_budget" — o controle de raciocínio é feito via
// "reasoning_effort" (low/medium/high) dentro de "chat_template_kwargs",
// conforme o exemplo oficial da NVIDIA/StepFun. "high" dá o raciocínio
// mais profundo, melhor pra código/jogos complexos, ao custo de mais
// tokens gastos pensando antes de escrever a resposta final.
const MAX_TOKENS = 131072;
// "high" gasta bastante do budget de tokens só raciocinando — em pedidos
// grandes (jogo/app completo) isso pode consumir o MAX_TOKENS inteiro
// antes do modelo sequer começar a escrever a resposta final, resultando
// em resposta vazia/truncada. "medium" dá um raciocínio bom mantendo mais
// espaço livre pra escrever o arquivo de verdade.
const REASONING_EFFORT = 'medium';

// O idioma de resposta agora é dinâmico (vem do campo "lang" que o
// frontend manda no body: "pt-BR" ou "en-US", conforme a escolha da
// pessoa nas configurações do app). O resto do prompt (regras de
// arquitetura, ferramentas etc.) continua em português porque são
// instruções internas pro modelo, não texto que o usuário vê — isso
// não afeta o idioma da resposta final.
function languageDirective(lang) {
  if (lang === 'en-US') {
    return 'Always respond in English (en-US), in a natural, clear and direct way, no matter what language the ' +
      'user writes in or what language earlier messages in this conversation were written in. This applies to ' +
      'every reply from now on.';
  }
  return 'Responda sempre em português do Brasil, de forma natural, clara e sem enrolação, independentemente do ' +
    'idioma usado pelo usuário ou de mensagens anteriores nesta conversa. Isso vale para toda resposta a partir de agora.';
}

function buildSystemPrompt(lang) {
  return (
  'Você é o Tato, um assistente de IA amigável, direto e prestativo do app Tato IA. ' +
  languageDirective(lang) + ' ' +
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
  '3. write_file (reescrever o arquivo inteiro) é aceitável em três casos: (a) criação inicial de um arquivo ' +
  'novo; (b) o usuário pedir explicitamente uma reescrita completa; ou (c) o pedido do usuário, mesmo sem pedir ' +
  'reescrita completa, exigir uma mudança estrutural/complexa demais pra um sed -i ou edit_file pontual (ex: ' +
  'adicionar uma feature nova que mexe em várias partes do arquivo, refatorar uma função inteira, mudar a lógica ' +
  'de várias seções relacionadas). Nesse caso (c), write_file é a ferramenta CERTA, não errada — o que é proibido ' +
  'não é reescrever o arquivo inteiro, e sim reescrevê-lo DIFERENTE do original. Ou seja: pra mudança pequena e ' +
  'isolada, use sed -i/edit_file; pra mudança grande/estrutural, pode e deve usar write_file, desde que siga a ' +
  'REGRA OBRIGATÓRIA abaixo (partir do conteúdo exato do arquivo antigo, mudar só o que foi pedido).\n' +
  '4. A ferramenta edit_file (old_str/new_str) também está disponível como alternativa a sed -i, mas run_command ' +
  'é a via preferida — é o formato em que você foi mais treinado a operar.\n' +
  'Antes de decidir qual ferramenta usar, pense rapidamente: "isso é uma mudança pontual em algo que já existe, ' +
  'ou é a criação de algo novo do zero?" Mudança pontual = run_command/sed -i. Criação nova = write_file.\n\n' +
  'NUNCA repita a mesma chamada de ferramenta (write_file, run_command, edit_file) mais de uma vez seguida com ' +
  'o mesmo arquivo e o mesmo conteúdo/comando dentro da mesma resposta. Cada arquivo deve ser escrito ou editado ' +
  'UMA ÚNICA VEZ por resposta. Se você perceber que já chamou write_file pra um arquivo e ainda não terminou de ' +
  'pensar no conteúdo, não chame write_file de novo pra "tentar de novo" ou "corrigir" — em vez disso, planeje ' +
  'o conteúdo completo mentalmente antes de fazer a chamada, e faça só uma chamada final por arquivo.\n\n' +
  'NOMEAÇÃO DE ARQUIVOS NOVOS — REGRA OBRIGATÓRIA: toda vez que você for CRIAR um arquivo do zero (não editar um ' +
  'que já existe), escolha você mesmo um nome novo, descritivo e específico pro conteúdo (ex: "jogo-cobrinha.html", ' +
  '"calculadora-imc.html", "landing-produto.html"). NUNCA reaproveite o nome de um arquivo que já existe na ' +
  'conversa (seja um arquivo que o usuário te mandou, seja um que você mesmo já criou antes), a menos que a ' +
  'intenção clara seja editar/sobrescrever aquele arquivo específico. Reusar nome de arquivo diferente é ERRADO ' +
  'e perigoso: quando dois arquivos de conteúdos diferentes têm o mesmo nome, um "cat"/"grep" posterior pode te ' +
  'fazer ler ou editar o arquivo errado sem perceber, misturando pedidos de coisas diferentes. Antes de rodar ' +
  'write_file num nome, se não tiver certeza se aquele nome já foi usado pra outra coisa, rode "ls" primeiro pra ' +
  'conferir. Se o usuário pedir algo novo e diferente do que já existe, dê um nome novo — não pergunte, apenas ' +
  'escolha um nome claro e siga.\n\n' +
  'VERSIONAMENTO DE NOME EM REESCRITA COMPLETA — REGRA OBRIGATÓRIA: toda vez que você reescrever um arquivo que ' +
  'já existe inteiro via write_file (casos (b) e (c) da regra 3 — pedido explícito de reescrita ou mudança ' +
  'estrutural grande), o arquivo resultante NÃO deve ficar com o nome idêntico ao anterior. Em vez disso, ' +
  'adicione um número sequencial logo antes da extensão, incrementando a cada nova reescrita completa daquele ' +
  'arquivo: se o nome atual é "jogo.html", a primeira reescrita completa vira "jogo1.html"; se pedirem outra ' +
  'reescrita completa em cima dessa, vira "jogo2.html"; e assim por diante. Se o nome atual já termina em número ' +
  '(ex: "jogo3.html"), a próxima reescrita completa incrementa esse número (vira "jogo4.html"), nunca reinicia. ' +
  'O motivo: cada reescrita completa gera uma entrega separada na conversa, e se duas entregas diferentes tiverem ' +
  'exatamente o mesmo nome, isso confunde qual delas é a mais recente/correta ao consultar o histórico depois — ' +
  'com números diferentes fica impossível confundir uma com a outra. IMPORTANTE: essa regra de numerar vale só ' +
  'pra reescrita COMPLETA via write_file num arquivo que já existia. Edições pontuais via run_command/sed -i ou ' +
  'edit_file continuam alterando o arquivo original no mesmo nome, sem numerar — não são uma "nova entrega", é o ' +
  'mesmo arquivo sendo ajustado no lugar. Depois de renomear, ao continuar a conversa, o arquivo "atual" pra ' +
  'qualquer novo pedido passa a ser o do nome mais recente/mais numerado — confirme sempre com "ls" se tiver ' +
  'dúvida de qual é a versão mais nova.\n\n' +
  'REGRA OBRIGATÓRIA PRA QUANDO A REESCRITA COMPLETA (write_file) FOR A OPÇÃO CERTA NUM ARQUIVO QUE JÁ EXISTE: ' +
  'isso vale nos casos (b) e (c) da regra 3 acima — pedido explícito de reescrita completa, ou mudança grande/' +
  'estrutural demais pra edição pontual. Nesses casos, você SEMPRE deve partir do conteúdo EXATO do arquivo ' +
  'antigo (visto via cat/grep recente nesta janela de contexto) e reescrevê-lo aplicando SOMENTE as melhorias/ ' +
  'mudanças que o usuário pediu. O que é proibido não é usar write_file — é usar write_file pra gerar um arquivo ' +
  'PARALELO/DIFERENTE do original. Nunca gere uma versão nova "do seu jeito", reorganizada, reescrita com outra ' +
  'estrutura, outros nomes de variável/função, outro estilo de código, comentários removidos/reescritos, ou ' +
  'qualquer trecho reformulado que o usuário não pediu pra mexer. Todo o resto do arquivo (código, comentários, ' +
  'formatação, ordem, nomes) deve permanecer IDÊNTICO ao original — igual a um diff limpo, onde só as linhas ' +
  'relacionadas ao pedido do usuário mudam. Se em algum momento você notar que está "recriando" o arquivo de ' +
  'memória ou do seu próprio estilo em vez de copiar o conteúdo real visto no cat/grep, pare e rode "cat" no ' +
  'arquivo de novo antes de continuar.\n\n' +
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
  'ou edição. Reescrever completamente (write_file) um arquivo que já existe é permitido nos casos (b) e (c) ' +
  'da regra 3 — não é restrito só a pedido explícito de reescrita total.\n\n' +
  'FERRAMENTA ask_user — QUANDO PERGUNTAR AO USUÁRIO: se em algum momento você tiver uma dúvida real que impede ' +
  'de continuar com qualidade (ex: duas abordagens válidas e bem diferentes, falta uma decisão de gosto/estilo, ' +
  'risco de sobrescrever algo importante, requisito ambíguo que muda o resultado), use a ferramenta ask_user em ' +
  'vez de adivinhar ou de simplesmente escrever a pergunta como texto normal. Não use pra coisas triviais que ' +
  'você mesmo pode decidir com bom senso. Ao chamar ask_user, ofereça duas opções curtas e realmente distintas ' +
  '(o usuário também pode responder outra coisa por conta própria) e chame essa ferramenta sozinha, sem combinar ' +
  'com outra chamada na mesma resposta. Assim que a resposta chegar como resultado da ferramenta, continue o ' +
  'raciocínio exatamente de onde parou, considerando o que foi respondido — não repita a pergunta nem recomece ' +
  'o que já tinha sido decidido antes dela.\n\n' +
  'FERRAMENTA ask_enable_search — QUANDO O MODO PESQUISA ESTÁ DESLIGADO: essa ferramenta só aparece disponível ' +
  'quando o modo Pesquisa do usuário está DESLIGADO (ou seja, você não tem a ferramenta web_search nesse momento). ' +
  'Se a pergunta ATUAL do usuário claramente depender de informação atual/recente que você não tem certeza ' +
  '(notícias, eventos recentes, preços, versão mais nova de uma lib/software, qualquer fato que pode ter mudado ' +
  'depois do seu treinamento), NÃO responda de memória arriscando errar, nem finja que pesquisou — chame ' +
  'ask_enable_search explicando em poucas palavras, no campo "reason", por que pesquisar ajudaria, e pergunte se ' +
  'pode ativar o modo Pesquisa. Se o usuário responder que sim, o modo Pesquisa é ativado automaticamente e a ' +
  'ferramenta web_search passa a estar disponível — use-a em seguida pra responder. Se o usuário responder que ' +
  'não, responda mesmo assim com o que você já sabe, mas deixe claro na resposta que a informação pode estar ' +
  'desatualizada ou incompleta por não ter sido possível pesquisar. Se o usuário responder de forma personalizada, ' +
  'siga a intenção dessa resposta. Não use essa ferramenta pra perguntas atemporais que você já sabe com certeza, ' +
  'nem force isso se pesquisar não ajudaria em nada — nesses casos responda normalmente sem chamar a ferramenta. ' +
  'Chame-a sozinha, sem combinar com outra chamada na mesma resposta.\n\n' +
  'ATENÇÃO — QUAL É A VERSÃO "ATUAL" DO ARQUIVO: se você mesmo editou um arquivo mais cedo nesta conversa (via ' +
  'write_file, sed -i ou edit_file), e o usuário em seguida pede pra ajustar/corrigir mais alguma coisa nesse ' +
  'mesmo arquivo, o ponto de partida é SEMPRE o estado do arquivo DEPOIS da sua última edição — nunca a versão ' +
  'de antes (seja a que o usuário mandou originalmente, seja uma versão intermediária). Não presuma de memória ' +
  'qual é o conteúdo atual mesmo que você mesmo tenha acabado de escrevê-lo: antes de aplicar a próxima mudança, ' +
  'rode "cat"/"grep" no arquivo de novo pra confirmar o estado real em disco (sua última escrita pode ter sido ' +
  'diferente do que você "lembra" ter escrito). Trate cada pedido novo de alteração como incidindo sobre o ' +
  'resultado da edição anterior, em cadeia — nunca volte a trabalhar em cima da versão original/pré-edição.'
  );
}

// Esse lembrete é reenviado no FINAL da lista de mensagens em TODA
// requisição (depois de todo o histórico da conversa), não só uma vez lá
// no system prompt do início. Motivo: em conversas longas, o system prompt
// original fica "distante" (antes de dezenas de mensagens) no momento em
// que o modelo decide o próximo passo, e regras específicas enterradas nele
// acabam sendo ignoradas na prática. Repetir a regra crítica bem coladinha
// no ponto onde o modelo vai gerar a próxima ação aumenta MUITO a chance
// dele realmente seguir — é a mesma técnica de "sanduíche" de instruções.
const FILE_REMINDER =
  'LEMBRETE CRÍTICO SOBRE ARQUIVOS (siga isso agora, não só o que estava no system prompt lá no início): ' +
  '(1) Antes de mexer em QUALQUER arquivo que já existe — seja pra editar pontualmente ou reescrever inteiro — ' +
  'rode "ls" e depois "cat"/"grep" pra confirmar o nome exato e o conteúdo REAL do arquivo AGORA, mesmo que você ' +
  'ache que já sabe (sua "lembrança" pode estar desatualizada ou ser de um arquivo diferente com nome parecido). ' +
  'Nunca edite ou analise um arquivo baseado só no que apareceu antes na conversa sem reconferir. ' +
  '(2) Se a ação certa for reescrever um arquivo já existente por completo (write_file), o nome do arquivo NOVO ' +
  'tem que ser diferente do nome atual: adicione um número antes da extensão, incrementando a partir do que já ' +
  'existir (ex: "jogo.html" existente → escreva "jogo1.html"; se já existir "jogo1.html" → escreva "jogo2.html"). ' +
  'NUNCA escreva um write_file usando exatamente o mesmo nome que um arquivo que já existe na conversa. ' +
  '(3) Se a ação for só um ajuste pontual (sed -i/edit_file) no arquivo, aí sim o nome continua o mesmo — não ' +
  'numera edição pontual, só reescrita completa.';

// Lembrete de idioma reenviado coladinho no final da lista de mensagens
// (mesma técnica de "sanduíche" usada no FILE_REMINDER acima) — garante
// que a instrução de idioma não fique "enterrada" lá no início do
// system prompt em conversas longas.
function buildLangReminder(lang) {
  if (lang === 'en-US') {
    return 'LANGUAGE REMINDER: reply in English (en-US) now, regardless of the language used earlier in this conversation.';
  }
  return 'LEMBRETE DE IDIOMA: responda agora em português do Brasil, independentemente do idioma usado antes nesta conversa.';
}

// Lembrete de DATA reenviado coladinho no final da lista de mensagens
// (mesmo "sanduíche" do FILE_REMINDER e do buildLangReminder acima).
// Antes, a única noção de data que o modelo tinha era o texto solto que
// o front colava na última mensagem do usuário quando o modo Pesquisa
// tava ligado — sem isso vindo do servidor, o modelo confiava na própria
// "memória" de treino (~2024) pra interpretar resultado de busca, e
// respondia como se ainda fosse 2024. Gerando a data aqui no servidor
// (igual já era feito pro FILE_REMINDER), ela chega em toda requisição,
// sempre atualizada, sem depender do front mandar certo.
function buildDateReminder(lang) {
  const now = new Date();
  if (lang === 'en-US') {
    const formatted = now.toLocaleDateString('en-US', {
      timeZone: 'America/Sao_Paulo', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
    });
    return 'DATE REMINDER: today is ' + formatted + '. Use this as the real current date for anything time-sensitive ' +
      '(news, search results, "latest"/"current" questions, calculating ages or time differences) — do not rely on ' +
      'your training data\'s sense of what year it is.';
  }
  const formatted = now.toLocaleDateString('pt-BR', {
    timeZone: 'America/Sao_Paulo', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });
  return 'LEMBRETE DE DATA: hoje é ' + formatted + '. Use isso como a data atual real pra qualquer coisa sensível ao ' +
    'tempo (notícias, resultados de pesquisa, perguntas sobre "mais recente"/"atual", cálculo de idade ou diferença ' +
    'de tempo) — não confie na sua noção de treino sobre em que ano você está.';
}

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
      // 'system' vindo do front (ex: instrução do modo Pesquisa ligado) —
      // antes caía direto no "return false" e era descartado em silêncio.
      if (m.role === 'system') return typeof m.content === 'string' && m.content.trim();
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
  const lang = (body && body.lang === 'en-US') ? 'en-US' : 'pt-BR';

  const payload = {
    model: MODEL,
    messages: [{ role: 'system', content: buildSystemPrompt(lang) }]
      .concat(history)
      .concat([
        { role: 'system', content: FILE_REMINDER },
        { role: 'system', content: buildDateReminder(lang) },
        { role: 'system', content: buildLangReminder(lang) }
      ]),
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

  // Retry com backoff exponencial pra erros 429 (rate limit) e 503/502
  // (sobrecarga momentânea do provedor). Tenta a chamada até MAX_RETRIES
  // vezes, respeitando o header "Retry-After" da API se ele vier, ou usando
  // backoff exponencial (1s, 2s, 4s) com um pouco de jitter caso não venha.
  // Só depois de esgotar as tentativas é que devolve erro pro usuário — e
  // nesse caso a mensagem é sempre genérica, sem expor o código/detalhe
  // técnico da API (rate limit é informação interna, não interessa ao
  // usuário final e pode até dar pista de limites pra abusar).
  const MAX_RETRIES = 3;
  const RETRYABLE_STATUS = new Set([429, 502, 503]);

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  let upstream;
  let lastErrStatus = null;
  let lastErrText = '';
  try {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      upstream = await fetch(NVIDIA_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + NVIDIA_API_KEY,
          'Accept': 'text/event-stream'
        },
        body: JSON.stringify(payload)
      });

      if (upstream.ok && upstream.body) break;

      lastErrStatus = upstream.status;
      const isRetryable = RETRYABLE_STATUS.has(upstream.status);
      const isLastAttempt = attempt === MAX_RETRIES;

      if (!isRetryable || isLastAttempt) {
        lastErrText = await upstream.text().catch(function () { return ''; });
        break;
      }

      // Descarta o corpo da resposta antes de tentar de novo, pra não
      // vazar a conexão.
      await upstream.text().catch(function () { return ''; });

      const retryAfterHeader = upstream.headers.get('retry-after');
      const retryAfterMs = retryAfterHeader ? (parseFloat(retryAfterHeader) * 1000) : null;
      const backoffMs = retryAfterMs && !isNaN(retryAfterMs)
        ? retryAfterMs
        : (1000 * Math.pow(2, attempt)) + Math.floor(Math.random() * 300);

      await sleep(backoffMs);
    }
  } catch (err) {
    return res.status(502).json({ ok: false, error: 'Server sobrecarregado, tente novamente mais tarde.' });
  }

  if (!upstream.ok || !upstream.body) {
    // Mensagem sempre genérica pro usuário, independente do status real
    // (429, 502, 503, etc) — não expõe detalhe técnico/interno da API.
    // O status/texto real fica só no log do servidor, pra debug.
    console.error('Erro upstream da IA após retries — status:', lastErrStatus, 'body:', (lastErrText || '').slice(0, 300));
    return res.status(502).json({ ok: false, error: 'Server sobrecarregado, tente novamente mais tarde.' });
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

  // Às vezes o modelo "engasga" e repete a mesma tool_call (ex: write_file
  // do mesmo arquivo com o mesmo conteúdo) 2, 3, 4 vezes seguidas dentro da
  // mesma resposta — um comportamento de repetição comum em LLMs, principal-
  // mente em respostas longas. Isso não corrompe o arquivo (é sempre o mesmo
  // conteúdo sendo escrito de novo por cima), mas é chato pro usuário ver
  // "N arquivos" idênticos aparecendo. Deduplica por (nome da função +
  // argumentos exatos), mantendo a primeira ocorrência — se alguma vier com
  // argumentos genuinamente diferentes (outro arquivo, outro conteúdo), ela
  // continua passando normalmente.
  function dedupeToolCalls(calls) {
    const seen = new Set();
    const out = [];
    for (const tc of calls) {
      const key = (tc.function && tc.function.name || '') + '\u0000' + (tc.function && tc.function.arguments || '');
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(tc);
    }
    return out;
  }

  const cleanToolCalls = dedupeToolCalls(toolCallsAcc.filter(Boolean));
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
