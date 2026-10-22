// ============================================================
// TATO IA — Chat Server (streaming SSE + Tool Calling) — Render
// Mesma lógica do worker do Cloudflare, só que rodando como um
// servidor Node normal (Express) num container que fica ligado o
// tempo todo — sem aquele limite de CPU time por request que existe
// no plano Free do Cloudflare Workers.
//
// Variável de ambiente necessária no Render (aba "Environment"):
//   NVIDIA_API_KEY = ...
// API OpenAI-compatible da NVIDIA (integrate.api.nvidia.com, endpoint
// /v1/chat/completions) usando o modelo Step 5 Preview (stepfun-ai/step-5-preview).
// ============================================================

import express from 'express';

const NVIDIA_ENDPOINT = 'https://integrate.api.nvidia.com/v1/chat/completions';
// ID confirmado na NVIDIA Build: stepfun-ai/step-5-preview.
const MODEL = 'stepfun-ai/step-5-preview';
// O Step 5 Preview mantém reasoning mesmo com enable_thinking=false. Para que
// o modo rápido seja realmente rápido, o Tato usa um checkpoint multimodal que
// aceita reasoning_effort='none'. "Pensar Mais" continua usando o Step 5 atual.
const MODEL_FAST = 'nvidia/nemotron-3.5-super-vl-120b-a12b';

// Rodando no Render (sem limite de CPU time por request), dá pra usar
// um timeout bem mais folgado do que dava no Cloudflare Free.
const FETCH_TIMEOUT_MS = 1200000; // 20 minutos (era 5 min — cortava em respostas longas/reescritas grandes)
const HEARTBEAT_MS = 12000;
const FLUSH_MS = 60;

// Tato 4.1 agora roda sobre Step 5 Preview (via NVIDIA). O limite de saída
// foi aumentado para 256K tokens.
// O reasoning é controlado pelo seletor "Pensar Mais" do frontend.
// Padrão: desligado (NONE); ativado apenas quando reasoning_enabled === true.
const MAX_TOKENS_STANDARD = 262144;
// O endpoint Nemotron 3.5 Super VL documenta máximo de saída de 131072 tokens.
// O limite de 262144 continua intacto no modo Pensar Mais (Step 5 Preview).
const MAX_TOKENS_FAST = 131072;

// Limite único de tamanho de arquivo no backend.
const MAX_FILE_BYTES_STANDARD = 1 * 1024 * 1024;

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


// ============================================================
// CONTEXTO DO MODO IMAGEM
// ============================================================

function normalizeImageContext(body, tools) {
  const explicit = body && body.image_context;

  if (explicit && typeof explicit === 'object') {
    const state = String(explicit.state || '').trim();

    if (
      state === 'guest' ||
      state === 'authenticated_off' ||
      state === 'authenticated_on'
    ) {
      return { state };
    }
  }

  const names = (Array.isArray(tools) ? tools : [])
    .map(function (tool) {
      return (
        tool &&
        tool.function &&
        tool.function.name
          ? String(tool.function.name)
          : ''
      );
    })
    .filter(Boolean);

  /*
   * Fallback:
   *
   * imagecreator só deve aparecer quando:
   * - usuário está autenticado
   * - modo imagem está ativo
   *
   * ask_image aparece quando:
   * - o modo imagem está desligado
   */
  if (names.includes('imagecreator')) {
    return {
      state: 'authenticated_on'
    };
  }

  if (names.includes('ask_image')) {
    return {
      state: 'authenticated_off'
    };
  }

  return {
    state: 'unknown'
  };
}


// ============================================================
// LEMBRETE FINAL DE IMAGEM
// ============================================================

function buildImageReminder(lang, imageContext, tools) {
  const state = imageContext && imageContext.state ? imageContext.state : 'unknown';
  const names = (Array.isArray(tools) ? tools : []).map(function(tool){
    return tool && tool.function && tool.function.name ? String(tool.function.name) : '';
  }).filter(Boolean);
  const hasCreator = names.includes('imagecreator');
  const hasAsk = names.includes('ask_image');
  if (lang === 'en-US') {
    if (state === 'guest') return 'IMAGE ACCESS: user is signed out; image generation is unavailable. ' + (hasAsk ? 'Use ask_image to explain Google login is required.' : 'Explain Google login is required.') + ' Never substitute code/HTML/SVG for an image.';
    if (state === 'authenticated_off') return 'IMAGE MODE: user is signed in but image generation is off. ' + (hasAsk ? 'Use ask_image to ask whether to enable it.' : 'Explain image mode must be enabled.') + ' Never substitute code/HTML/SVG for an image.';
    if (state === 'authenticated_on') return 'IMAGE MODE is on. For image-generation requests use imagecreator when available (' + hasCreator + '); never substitute code/HTML/SVG.';
    return 'For image-generation requests, use the dedicated image tool when available; never substitute code/HTML/SVG.';
  }
  if (state === 'guest') return 'ACESSO A IMAGENS: usuário não está autenticado; geração indisponível. ' + (hasAsk ? 'Use ask_image para explicar que o login Google é necessário.' : 'Explique que o login Google é necessário.') + ' Nunca substitua imagem por código/HTML/SVG.';
  if (state === 'authenticated_off') return 'MODO IMAGEM: usuário está autenticado, mas a geração está desligada. ' + (hasAsk ? 'Use ask_image para perguntar se pode ativar.' : 'Explique que é preciso ativar o modo.') + ' Nunca substitua imagem por código/HTML/SVG.';
  if (state === 'authenticated_on') return 'MODO IMAGEM ligado: em pedidos de geração, use imagecreator quando disponível (' + hasCreator + '); nunca substitua por código/HTML/SVG.';
  return 'Em pedidos de geração de imagem, use a ferramenta de imagem quando disponível; nunca substitua por código/HTML/SVG.';
}


// ============================================================
// SYSTEM PROMPT
// ============================================================

function buildSystemPrompt(lang) {
  return (
  'Você é o Tato 4.1, o agente principal do app Tato IA. ' +
  'Você opera como agente, não apenas como chatbot. Quando ferramentas estiverem disponíveis, avalie a solicitação e use as ferramentas necessárias antes de responder. ' +
  'Em tarefas de programação e arquivos, atue diretamente pelas ferramentas: inspecione o estado real, crie/edite os arquivos, execute verificações e só finalize quando a tarefa estiver concluída. ' +
  'Nunca entregue projetos grandes ou código completo diretamente no chat quando uma ferramenta de arquivo puder criar o arquivo. Nunca alegue ter executado, testado, pesquisado ou alterado algo sem usar a ferramenta correspondente. ' +
  languageDirective(lang) +
  '\n\n' +

  'DISCIPLINA DE EXECUÇÃO, CLAREZA E ANTI-REPETIÇÃO: trabalhe de forma objetiva e consistente. Antes de agir, ' +
  'identifique o objetivo e as restrições essenciais; em tarefas simples, faça isso rapidamente e comece a execução. ' +
  'Em tarefas complexas, mantenha um plano curto e estável, atualizando-o apenas quando surgir uma descoberta real. ' +
  'Não volte a reconsiderar uma decisão já tomada sem informação nova, erro observado, dependência ou risco concreto. ' +
  'Não fique alternando entre opções equivalentes nem repita a mesma dúvida com palavras diferentes: escolha a opção ' +
  'que melhor satisfaz o pedido e prossiga. Se houver dependências entre ações, respeite a ordem; se forem independentes ' +
  'e a interface permitir, faça as chamadas separadas no mesmo turno, em vez de prolongar a análise sobre como agrupá-las. ' +
  'Quando o usuário pedir expressamente execução uma por vez, faça uma chamada separada por comando e não os encadeie ' +
  'numa única linha de shell. Ao responder, não repita a mesma palavra, expressão, frase, conclusão ou explicação sem ' +
  'necessidade. Evite reformular várias vezes o que já disse, fazer introduções longas, narrar indecisões ou repetir o ' +
  'plano inteiro após cada etapa. Dê uma explicação por ponto, elimine redundâncias e vá direto ao resultado. Preserve ' +
  'repetições necessárias para exatidão, nomes de variáveis, código, citações, instruções de segurança ou clareza. ' +
  'Em tarefas com ferramentas, aja com base no estado observado, leia os resultados reais e faça verificações proporcionais ' +
  'ao risco. Não alegue sucesso antes de confirmar. Se algo falhar, identifique o erro concreto e corrija-o sem reiniciar ' +
  'todo o planejamento nem repetir tentativas idênticas sem uma razão nova. O raciocínio deve servir para decidir e ' +
  'executar, não para prolongar decisões resolvidas. Na resposta visível, apresente apenas progresso útil, resultado, ' +
  'limitações reais e próximos passos essenciais. ' +
  '\n\n' +

  'CONTEXTO DOS MODELOS DO TATO: o app Tato oferece dois modelos que a pessoa escolhe no seletor. Tato 2.9 é o ' +
  'modelo principal, feito pra ser rápido e bom em tarefas do dia a dia, perguntas simples e uso geral com alta ' +
  'velocidade de resposta. Tato 4.1 (você) é o modelo mais potente do Tato, com raciocínio mais forte — a escolha ' +
  'certa pra tarefas complexas: programação e arquivos maiores, depuração, arquitetura de projetos, mudanças que ' +
  'exigem entender bastante contexto, e qualquer coisa que se beneficie de mais raciocínio antes de responder. Se ' +
  'o usuário perguntar qual modelo é melhor, qual escolher pra determinada tarefa, ou como os dois se comparam, ' +
  'responda com naturalidade usando essa diferença (2.9 = rapidez/tarefas simples, 4.1 = potência/raciocínio para ' +
  'tarefas complexas). NUNCA revele qual motor/API roda por trás de nenhum dos dois modelos — isso é informação ' +
  'interna e nunca deve ser mencionada, mesmo comparando os dois. ' +
  '\n\n' +

  'FERRAMENTA import_project_file: se o usuário mencionar um Project (inclusive {NomeDoProjeto}) e pedir uma ação ' +
  'sobre arquivo que não foi anexado diretamente à conversa, importe o arquivo antes de ler ou editar. Se configs ou ' +
  'arquivos complementares puderem ser necessários, use include_complements=true. Só pule a importação quando o arquivo ' +
  'já estiver disponível nesta conversa, confirmado por list_files quando necessário. ' +
  '\n\n' +

  'Para pedidos que resultem em arquivos (código, scripts, sites ou apps), use a ferramenta de arquivo adequada ' +
  'em vez de despejar um projeto grande no chat. Depois, confirme brevemente o resultado real. ' +
  '\n\n' +

  'FERRAMENTA notes: use em tarefas realmente extensas, com várias fases ou possibilidade de retomada. Registre ' +
  'um plano curto no início e atualize em marcos relevantes; não crie notas para tarefas simples nem registre cada chamada. ' +
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

  'REGRA PARA PYTHON COM INTERFACE DE TERMINAL (curses): o Python do usuário roda no Pydroid (Android), cujo ' +
  'ncurses NÃO tem suporte a wide-char. Isso significa que "chtype" só aceita caracteres de 0-255 (ASCII/Latin-1 ' +
  'básico) — qualquer caractere fora disso (emoji, bordas Unicode como bordas em caixa, blocos sólidos, setas, ' +
  'corações etc) usado em addch/addstr/insch derruba o programa com "OverflowError: byte doesn\'t fit in ' +
  'chtype". Portanto, ao gerar qualquer script Python com curses (ou qualquer interface de terminal com visual, ' +
  'tipo jogos ASCII), use SOMENTE caracteres ASCII puro pra desenhar a UI: #, *, +, -, |, =, @, <3 no lugar de ' +
  'bordas ou ícones especiais. Nunca gere um Python "sem visual" como fallback por medo desse erro — gere o ' +
  'visual de verdade, só que 100% em ASCII, pra funcionar sem quebrar. \n\n' +

  'POLÍTICA DE ARQUIVOS: antes de editar um arquivo existente, confirme caminho e conteúdo atual com uma leitura ' +
  'pertinente; não repita inspeções se o estado já estiver confirmado e não houver mudança relevante. Use sed/edit_file ' +
  'para alterações localizadas; use write_file para arquivos novos ou mudanças estruturais/reescritas necessárias. ' +
  'Preserve todo conteúdo fora do escopo. Faça novas edições quando um teste ou evidência concreta revelar um defeito; ' +
  'evite apenas repetir chamadas idênticas sem motivo. Para arquivos novos, escolha nomes descritivos e únicos. Ao ' +
  'reescrever por completo um arquivo existente via write_file, use uma versão com sufixo numérico crescente; mudanças ' +
  'pontuais mantêm o nome. Confirme o resultado com verificações proporcionais ao risco. ' +
  '\n\n' +

  'FERRAMENTA redacao — QUANDO O USUÁRIO PEDIR UMA REDAÇÃO: sempre que o usuário pedir pra você escrever uma ' +
  'redação, dissertação, texto dissertativo-argumentativo ou algo equivalente (ex: "faz uma redação sobre...", ' +
  '"escreve uma dissertação sobre...", redação nos moldes do ENEM/vestibular), NÃO escreva o texto da redação como ' +
  'texto corrido normal da conversa. Em vez disso, use a ferramenta redacao, passando um título curto (campo ' +
  '"titulo") e o texto completo da redação (campo "texto"), com os parágrafos separados por linha em branco. Isso ' +
  'faz a redação aparecer num bloco próprio, com contagem de caracteres e nota estimada — muito mais fácil de ler ' +
  'do que texto solto no meio do chat. Depois de chamar a ferramenta, apenas confirme brevemente em texto (sem ' +
  'repetir o conteúdo da redação).\n\n' +

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
  'não, responda mesmo assim com o que já sabe, mas deixe claro na resposta que a informação pode estar ' +
  'desatualizada ou incompleta por não ter sido possível pesquisar. Se o usuário responder de forma personalizada, ' +
  'siga a intenção dessa resposta. Não use essa ferramenta pra perguntas atemporais que você já sabe com certeza, ' +
  'nem force isso se pesquisar não ajudaria em nada — nesses casos responda normalmente sem chamar a ferramenta. ' +
  'Chame-a sozinha, sem combinar com outra chamada na mesma resposta.\n\n' +

  'FERRAMENTA github — QUANDO CONSULTAR O GITHUB: você tem uma ferramenta chamada "github" (sempre disponível, ' +
  'independe do modo Pesquisa) que consulta a API real do GitHub — busca de código (search_code), busca de ' +
  'repositórios (search_repos), leitura de arquivo específico (get_file), listagem de pasta (list_dir), metadados ' +
  'de repositório como stars/linguagem/descrição (repo_info) e última versão publicada de uma lib/framework ' +
  '(latest_release). Use esta ferramenta PROATIVAMENTE, sem o usuário precisar pedir, sempre que: (a) precisar ' +
  'confirmar a versão mais recente de uma biblioteca/framework antes de recomendá-la ou usá-la em código gerado; ' +
  '(b) quiser um exemplo real de uso de uma API/lib em vez de escrever de memória e arriscar sintaxe desatualizada ' +
  'ou inventada; (c) o usuário pedir explicitamente pra ver/ler código de um repositório específico do GitHub; ' +
  '(d) precisar decidir entre duas libs e quiser comparar popularidade (stars) ou ver se um projeto ainda está ' +
  'mantido (campo archived/updated_at). Prefira github a web_search quando o que você precisa é um dado técnico ' +
  'exato (versão, conteúdo de arquivo, metadado de repo) — web_search é melhor pra notícia/contexto geral, github ' +
  'é melhor pra dado estruturado direto da fonte. Não anuncie que vai usar a ferramenta nem explique o processo de ' +
  'busca ao usuário; apenas chame e use o resultado naturalmente na resposta.\n\n' +

  'FERRAMENTA screenshot_html: use para conferir uma interface criada/alterada de forma relevante ou diagnosticar ' +
  'um problema visual. Use selector para isolar a área alterada; faça versões mobile/desktop quando a responsividade ' +
  'for pertinente. Combine screenshot com test_html_sandbox quando houver lógica executável: um print é estático e não ' +
  'comprova funcionamento. Não repita prints sem mudança e nunca diga que conferiu o visual sem realmente analisar o resultado.\n\n'
  );
}


// ============================================================
// LEMBRETE DE ARQUIVOS
// ============================================================

// Este lembrete curto só é anexado quando a mensagem recente indica trabalho com arquivos.
const FILE_REMINDER =
  'ARQUIVOS: para editar, use o conteúdo atual verificado e preserve tudo o que não foi solicitado. Evite reler sem motivo se o estado não mudou.';

function userTextForPolicy(message) {
  if (!message || message.role !== 'user') return '';
  if (typeof message.content === 'string') return message.content;
  if (Array.isArray(message.content)) return message.content
    .filter(function(part){ return part && part.type === 'text' && typeof part.text === 'string'; })
    .map(function(part){ return part.text; }).join(' ');
  return '';
}

function shouldAttachFileReminder(history) {
  if (!Array.isArray(history)) return false;
  const recentUserTexts = history.filter(function(message){ return message && message.role === 'user'; })
    .slice(-5).map(userTextForPolicy);
  if (!recentUserTexts.length) return false;
  const latest = recentUserTexts[recentUserTexts.length - 1] || '';
  const hasWorkIntent = /\b(crie|criar|faca|faça|edite|editar|corrija|corrigir|conserte|consertar|altere|alterar|modifique|modificar|implemente|implementar|adicione|adicionar|construa|construir|desenvolva|desenvolver|teste|testar|refatore|refatorar|reescreva|reescrever|melhore|melhorar|ajuste|ajustar|arruma|arrumar|muda|mudar|resolve|resolver|debug|corrige|continua|continue|aplique|aplicar)\b/i.test(latest);
  if (!hasWorkIntent) return false;
  const fileContextRe = /\b(arquivo|arquivos|codigo|código|script|programa|projeto|site|app|aplicativo|jogo|html|css|javascript|typescript|python|node\.js|funcao|função|bug|erro|terminal|tatoEOF|grep|sed|commit|deploy|pagina|página)\b/i;
  return recentUserTexts.some(function(text){ return fileContextRe.test(text); });
}


// ============================================================
// LEMBRETE DE DATA
// ============================================================

function buildDateReminder(lang) {
  const now = new Date();

  if (lang === 'en-US') {
    const formatted =
      now.toLocaleDateString(
        'en-US',
        {
          timeZone:
            'America/Sao_Paulo',

          weekday:
            'long',

          year:
            'numeric',

          month:
            'long',

          day:
            'numeric'
        }
      );

    return 'DATE REMINDER: today is ' +
      formatted +
      '. Use this as the real current date for anything time-sensitive ' +
      '(news, search results, "latest"/"current" questions, calculating ages or time differences) — do not rely on ' +
      'your training data\'s sense of what year it is.';
  }


  const formatted =
    now.toLocaleDateString(
      'pt-BR',
      {
        timeZone:
          'America/Sao_Paulo',

        weekday:
          'long',

        year:
          'numeric',

        month:
          'long',

        day:
          'numeric'
      }
    );


  return 'LEMBRETE DE DATA: hoje é ' +
    formatted +
    '. Use isso como a data atual real pra qualquer coisa sensível ao ' +
    'tempo (notícias, resultados de pesquisa, perguntas sobre "mais recente"/"atual", cálculo de idade ou diferença ' +
    'de tempo) — não confie na sua noção de treino sobre em que ano você está.';
}


// ============================================================
// TRIM
// ============================================================

function trimToSafeBoundary(
  text
) {
  const windowStart =
    Math.max(
      0,
      text.length - 800
    );

  const tail =
    text.slice(
      windowStart
    );


  let idx =
    tail.lastIndexOf(
      '\n\n'
    );

  if (idx !== -1) {
    return text
      .slice(
        0,
        windowStart + idx
      )
      .trimEnd();
  }


  const sentenceRe =
    /[.!?]["'“”’)\]]?\s/g;

  let lastIdx = -1;
  let m;

  while (
    (m =
      sentenceRe.exec(
        tail
      ))
  ) {
    lastIdx =
      m.index +
      m[0].length;
  }

  if (lastIdx !== -1) {
    return text
      .slice(
        0,
        windowStart +
          lastIdx
      )
      .trimEnd();
  }


  idx =
    tail.lastIndexOf(
      ' '
    );

  if (idx !== -1) {
    return text
      .slice(
        0,
        windowStart + idx
      )
      .trimEnd();
  }


  return text;
}


// ============================================================
// NORMALIZE HISTORY + MULTIMODAL (TEXT/IMAGE)
// ============================================================

// Step 5 Preview accepts image_url content parts using either an HTTPS URL
// or an image data URL (Base64). Supported data URL formats: PNG, JPEG and WebP.
function isSupportedVisionUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  const url = value.trim();
  return /^https?:\/\/\S+$/i.test(url) ||
    /^data:image\/(?:png|jpe?g|webp);base64,[a-z0-9+/=\r\n]+$/i.test(url);
}

function normalizeVisionContent(content) {
  if (typeof content === 'string') {
    return content.trim() ? content.trim() : null;
  }
  if (!Array.isArray(content)) return null;

  const normalized = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;

    if (part.type === 'text' && typeof part.text === 'string') {
      if (part.text.trim()) normalized.push({ type: 'text', text: part.text });
      continue;
    }

    if (part.type === 'image_url') {
      const imageUrl = typeof part.image_url === 'string'
        ? part.image_url
        : part.image_url && part.image_url.url;
      if (!isSupportedVisionUrl(imageUrl)) continue;

      const imagePart = {
        type: 'image_url',
        image_url: { url: imageUrl.trim() }
      };
      const detail = part.image_url && typeof part.image_url === 'object'
        ? part.image_url.detail
        : part.detail;
      if (['auto', 'low', 'high'].includes(detail)) {
        imagePart.image_url.detail = detail;
      }
      normalized.push(imagePart);
    }
  }

  return normalized.length ? normalized : null;
}

function normalizeHistory(incoming) {
  if (!Array.isArray(incoming)) return [];

  return incoming
    .filter(function (m) {
      if (!m || typeof m !== 'object') return false;

      if (m.role === 'user') {
        return !!normalizeVisionContent(m.content);
      }

      if (m.role === 'assistant') {
        return (
          (typeof m.content === 'string' && m.content.trim()) ||
          typeof m.reasoning_content === 'string' ||
          Array.isArray(m.tool_calls)
        );
      }

      if (m.role === 'tool') {
        return typeof m.content === 'string' && !!m.tool_call_id;
      }

      if (m.role === 'system') {
        return typeof m.content === 'string' && !!m.content.trim();
      }

      return false;
    })
    .slice(-60)
    .map(function (m) {
      if (m.role === 'tool') {
        return {
          role: 'tool',
          tool_call_id: m.tool_call_id,
          content: m.content
        };
      }

      if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
        return {
          role: 'assistant',
          content: typeof m.content === 'string' ? (m.content || null) : null,
          tool_calls: m.tool_calls,
          ...(typeof m.reasoning_content === 'string'
            ? { reasoning_content: m.reasoning_content }
            : {})
        };
      }

      if (m.role === 'user') {
        return {
          role: 'user',
          content: normalizeVisionContent(m.content)
        };
      }

      return {
        role: m.role,
        content: typeof m.content === 'string' ? m.content.trim() : null,
        ...(m.role === 'assistant' && typeof m.reasoning_content === 'string'
          ? { reasoning_content: m.reasoning_content }
          : {})
      };
    });
}

// Also accept body.images as an optional convenience for clients that send
// image attachments separately from messages. Entries may be URLs, data URLs,
// or objects shaped like { url: "..." } / { image_url: { url: "..." } }.
function attachSeparateImages(history, rawImages) {
  if (!Array.isArray(rawImages) || !rawImages.length) return history;

  let userIndex = -1;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i] && history[i].role === 'user') {
      userIndex = i;
      break;
    }
  }
  if (userIndex < 0) return history;

  const current = history[userIndex].content;
  if (Array.isArray(current) && current.some(part => part && part.type === 'image_url')) {
    return history; // Images are already included in the message content.
  }

  const imageParts = [];
  for (const entry of rawImages) {
    const candidate = typeof entry === 'string'
      ? entry
      : entry && (
          entry.url ||
          (typeof entry.image_url === 'string' ? entry.image_url : entry.image_url && entry.image_url.url)
        );
    if (isSupportedVisionUrl(candidate)) {
      imageParts.push({ type: 'image_url', image_url: { url: candidate.trim() } });
    }
  }
  if (!imageParts.length) return history;

  const parts = Array.isArray(current)
    ? current.slice()
    : (typeof current === 'string' && current.trim()
        ? [{ type: 'text', text: current }]
        : []);
  history[userIndex] = {
    ...history[userIndex],
    content: parts.concat(imageParts)
  };
  return history;
}

// NVIDIA documents a maximum of eight images per request. Keep the newest
// eight if a long conversation accumulated older image attachments.
function limitHistoryImages(history) {
  let total = 0;
  for (const message of history) {
    if (message && Array.isArray(message.content)) {
      total += message.content.filter(part => part && part.type === 'image_url').length;
    }
  }
  let toRemove = Math.max(0, total - 8);
  if (!toRemove) return history;

  for (const message of history) {
    if (toRemove <= 0) break;
    if (!message || !Array.isArray(message.content)) continue;
    const next = [];
    for (const part of message.content) {
      if (toRemove > 0 && part && part.type === 'image_url') {
        toRemove--;
        continue;
      }
      next.push(part);
    }
    message.content = next;
  }
  return history;
}


// ============================================================
// DETECÇÃO DE PEDIDO EXPLÍCITO DE GITHUB
// ============================================================

function getLatestUserMessage(history) {
  if (!Array.isArray(history)) return '';
  for (let i = history.length - 1; i >= 0; i--) {
    const message = history[i];
    if (message && message.role === 'user' && typeof message.content === 'string') {
      return message.content.trim();
    }
  }
  return '';
}

function isExplicitGithubRequest(history) {
  const text = getLatestUserMessage(history);
  if (!text) return false;
  const normalized = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  if (
    /\bnao\b[\s\S]{0,40}\bgithub\b/i.test(normalized) ||
    /\bsem\b[\s\S]{0,40}\bgithub\b/i.test(normalized) ||
    /\bdont\b[\s\S]{0,40}\bgithub\b/i.test(normalized) ||
    /\bdo not\b[\s\S]{0,40}\bgithub\b/i.test(normalized)
  ) return false;
  if (/github\.com\//i.test(text)) return true;
  if (!/\bgithub\b/i.test(normalized)) return false;
  return (
    /\b(use|usar|utilize|utilizar|consulte|consultar|pesquise|pesquisar|busque|buscar|procure|procurar|leia|ler|abra|abrir|acesse|acessar)\b[\s\S]{0,80}\bgithub\b/i.test(normalized) ||
    /\bgithub\b[\s\S]{0,80}\b(use|usar|utilize|utilizar|consulte|consultar|pesquise|pesquisar|busque|buscar|procure|procurar|leia|ler|abra|abrir|acesse|acessar)\b/i.test(normalized) ||
    /\bferramenta\b[\s\S]{0,40}\bgithub\b/i.test(normalized) ||
    /\bgithub\s+(?:api|repo|repositorio|codigo|arquivo|arquivos|lib|biblioteca|versao|release)\b/i.test(normalized)
  );
}

// ============================================================
// THINK FILTER
// ============================================================

function makeThinkFilter() {
  let buffer = '';
  let inThink = false;


  function feed(
    chunk
  ) {
    buffer +=
      chunk;

    let visible = '';
    let thinking = '';


    while (true) {

      if (!inThink) {

        const i =
          buffer.indexOf(
            '<think>'
          );

        if (i !== -1) {
          visible +=
            buffer.slice(
              0,
              i
            );

          buffer =
            buffer.slice(
              i + 7
            );

          inThink =
            true;

          continue;
        }


        const holdBack =
          Math.min(
            6,
            buffer.length
          );

        visible +=
          buffer.slice(
            0,
            buffer.length -
              holdBack
          );

        buffer =
          buffer.slice(
            buffer.length -
              holdBack
          );

        break;

      } else {

        const j =
          buffer.indexOf(
            '</think>'
          );

        if (j !== -1) {
          thinking +=
            buffer.slice(
              0,
              j
            );

          buffer =
            buffer.slice(
              j + 8
            );

          inThink =
            false;

          continue;
        }


        const holdBack =
          Math.min(
            7,
            buffer.length
          );

        thinking +=
          buffer.slice(
            0,
            buffer.length -
              holdBack
          );

        buffer =
          buffer.slice(
            buffer.length -
              holdBack
          );

        break;
      }
    }


    return {
      visible:
        visible,

      thinking:
        thinking
    };
  }


  function flushRemainder() {
    const leftover =
      buffer;

    buffer = '';
    inThink =
      false;

    return {
      visible:
        leftover,

      thinking:
        ''
    };
  }


  return {
    feed:
      feed,

    flushRemainder:
      flushRemainder
  };
}


// ============================================================
// EXPRESS
// ============================================================

const app =
  express();

app.use(
  express.json({
    limit:
      '35mb'
  })
);


app.use(
  function (
    req,
    res,
    next
  ) {
    res.setHeader(
      'Access-Control-Allow-Origin',
      '*'
    );

    res.setHeader(
      'Access-Control-Allow-Methods',
      'POST, OPTIONS'
    );

    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization'
    );

    if (
      req.method ===
      'OPTIONS'
    ) {
      return res
        .status(204)
        .end();
    }

    next();
  }
);


// ============================================================
// HEALTH
// ============================================================

app.get(
  '/health',
  function (
    req,
    res
  ) {
    res
      .status(200)
      .send('ok');
  }
);


// ============================================================
// CHAT
// ============================================================

app.post(
  '/',
  async function (
    req,
    res
  ) {

    const NVIDIA_API_KEY =
      process.env.NVIDIA_API_KEY;


    if (!NVIDIA_API_KEY) {
      return res
        .status(500)
        .json({
          ok:
            false,

          error:
            'NVIDIA_API_KEY não configurada nas variáveis de ambiente.'
        });
    }


    const body =
      req.body;


    const history = limitHistoryImages(
      attachSeparateImages(
        normalizeHistory(body && body.messages),
        body && body.images
      )
    );


    if (!history.length) {
      return res
        .status(400)
        .json({
          ok:
            false,

          error:
            'Nenhuma mensagem enviada.'
        });
    }


    const tools =
      Array.isArray(
        body &&
          body.tools
      )
        ? body.tools
        : undefined;


    const hasGithubTool =
      Array.isArray(tools) &&
      tools.some(function (tool) {
        return tool && tool.function && tool.function.name === 'github';
      });

    const explicitGithubRequest =
      isExplicitGithubRequest(history);

    if (explicitGithubRequest) {
      console.log(
        'Pedido explícito de GitHub detectado — ferramenta:',
        hasGithubTool ? 'FORÇADA' : 'INDISPONÍVEL NO REQUEST'
      );
    }

    const lang =
      (
        body &&
        body.lang ===
          'en-US'
      )
        ? 'en-US'
        : 'pt-BR';

    // Este worker é o backend do Tato 4.1.
    const modelMode = 'tato-4.1';
    const reasoningEnabled = !!(body && body.reasoning_enabled === true);
    // O botão escolhe um modo real de inferência: o modelo atual com raciocínio
    // completo ou o modelo multimodal de execução rápida com reasoning_effort=none.
    const requestModel = reasoningEnabled ? MODEL : MODEL_FAST;
    const requestMaxTokens = reasoningEnabled ? MAX_TOKENS_STANDARD : MAX_TOKENS_FAST;


    const imageContext =
      normalizeImageContext(
        body,
        tools
      );


    const payload = {
      model:
        requestModel,

      messages:
        [
          {
            role:
              'system',

            content:
              buildSystemPrompt(lang)
          }
        ]
        .concat(
          history
        )
        .concat(
          [
            ...(shouldAttachFileReminder(history) ? [{ role: 'system', content: FILE_REMINDER }] : []),

            {
              role:
                'system',

              content:
                buildDateReminder(
                  lang
                )
            },

            {
              role:
                'system',

              content:
                buildImageReminder(
                  lang,
                  imageContext,
                  tools
                )
            },

            ...(explicitGithubRequest && hasGithubTool
              ? [{
                  role: 'system',
                  content:
                    'GITHUB TOOL OVERRIDE: o pedido atual do usuário menciona explicitamente GitHub. ' +
                    'É OBRIGATÓRIO chamar a ferramenta github nesta resposta antes de responder. ' +
                    'Não responda apenas de memória e não substitua a chamada por web_search. ' +
                    'Use a operação do GitHub mais adequada ao pedido atual. ' +
                    'Depois de receber o resultado da ferramenta, responda normalmente.'
                }]
              : [])
          ]
        ),

      // Limite máximo de saída: 256K tokens. O corpo JSON aceita até 35 MB
      // para mensagens multimodais com imagens Base64 e histórico textual.
      max_tokens:
        requestMaxTokens,

      temperature: 0.2,

      // Pensar Mais usa o template original do Step 5. No modo rápido, usamos
      // o controle oficialmente suportado pelo Nemotron: reasoning_effort=none.
      ...(reasoningEnabled
        ? { chat_template_kwargs: { enable_thinking: true, preserve_thinking: true } }
        : { reasoning_effort: 'none' }),

      stream:
        true
    };


    if (
      tools &&
      tools.length
    ) {
      payload.tools =
        tools;

      // Em pedido explícito de GitHub, a API é instruída a chamar a função
      // diretamente. Isso evita depender apenas da decisão do modelo.
      if (explicitGithubRequest && hasGithubTool) {
        payload.tool_choice = {
          type: 'function',
          function: {
            name: 'github'
          }
        };
      } else {
        payload.tool_choice =
          'auto';
      }
    }


    // ==========================================================
    // RETRIES (nível transporte: 429/502/503 vindos da NVIDIA antes
    // mesmo de começar a receber qualquer byte do stream)
    // ==========================================================

    const MAX_RETRIES =
      3;

    const RETRYABLE_STATUS =
      new Set([
        429,
        502,
        503
      ]);


    function sleep(
      ms
    ) {
      return new Promise(
        function (
          resolve
        ) {
          setTimeout(
            resolve,
            ms
          );
        }
      );
    }

    // Extraído pra função porque agora pode ser chamado mais de uma vez:
    // uma vez antes de abrir o SSE pro cliente, e de novo (silenciosamente)
    // se uma tentativa terminar em "resposta vazia" (ver MAX_EMPTY_RETRIES
    // mais abaixo). Retorna o Response da NVIDIA em caso de sucesso, ou
    // null depois de já ter respondido `res` com um erro 502 (só é seguro
    // fazer isso ANTES de res.writeHead ter sido chamado pro SSE).
    async function requestUpstreamWithRetry() {
      let upstream;
      let lastErrStatus = null;
      let lastErrText = '';

      try {

        for (
          let attempt = 0;
          attempt <=
            MAX_RETRIES;
          attempt++
        ) {

          upstream =
            await fetch(
              NVIDIA_ENDPOINT,
              {
                method:
                  'POST',

                headers: {
                  'Content-Type':
                    'application/json',

                  'Authorization':
                    'Bearer ' +
                    NVIDIA_API_KEY,

                  'Accept':
                    'text/event-stream'
                },

                body:
                  JSON.stringify(
                    payload
                  )
              }
            );


          if (
            upstream.ok &&
            upstream.body
          ) {
            return { upstream };
          }


          lastErrStatus =
            upstream.status;


          const isRetryable =
            RETRYABLE_STATUS.has(
              upstream.status
            );


          const isLastAttempt =
            attempt ===
            MAX_RETRIES;


          if (
            !isRetryable ||
            isLastAttempt
          ) {
            lastErrText =
              await upstream
                .text()
                .catch(
                  function () {
                    return '';
                  }
                );

            break;
          }


          await upstream
            .text()
            .catch(
              function () {
                return '';
              }
            );


          const retryAfterHeader =
            upstream.headers.get(
              'retry-after'
            );


          const retryAfterMs =
            retryAfterHeader
              ? (
                  parseFloat(
                    retryAfterHeader
                  ) *
                  1000
                )
              : null;


          const backoffMs =
            retryAfterMs &&
            !isNaN(
              retryAfterMs
            )
              ? retryAfterMs
              : (
                  1000 *
                  Math.pow(
                    2,
                    attempt
                  )
                ) +
                Math.floor(
                  Math.random() *
                    300
                );


          await sleep(
            backoffMs
          );
        }

      } catch (
        err
      ) {

        return { fatal: true };
      }

      console.error(
        'Erro upstream da IA após retries — status:',
        lastErrStatus,
        'body:',
        (
          lastErrText ||
          ''
        ).slice(
          0,
          300
        )
      );

      return { fatal: true };
    }

    let upstream;
    {
      const first = await requestUpstreamWithRetry();
      if (first.fatal || !first.upstream) {
        return res
          .status(502)
          .json({
            ok:
              false,

            error:
              'Server sobrecarregado, tente novamente mais tarde.'
          });
      }
      upstream = first.upstream;
    }


    // ==========================================================
    // SSE
    // ==========================================================

    res.writeHead(
      200,
      {
        'Content-Type':
          'text/event-stream; charset=utf-8',

        'Cache-Control':
          'no-cache, no-transform',

        'Connection':
          'keep-alive',

        'X-Accel-Buffering':
          'no'
      }
    );


    let closed =
      false;


    let reader =
      null;


    function send(
      obj
    ) {
      if (closed) {
        return;
      }

      try {
        res.write(
          'data: ' +
          JSON.stringify(
            obj
          ) +
          '\n\n'
        );
      } catch (e) {
        // conexão já fechou
      }
    }


    function ping() {
      if (closed) {
        return;
      }

      try {
        res.write(
          ': ping\n\n'
        );
      } catch (e) {
        // conexão já fechou
      }
    }


    function finish() {

      if (closed) {
        return;
      }


      closed =
        true;


      clearInterval(
        heartbeatId
      );


      clearTimeout(
        timeoutId
      );


      try {
        res.end();
      } catch (e) {
        // já fechado
      }
    }


    const heartbeatId =
      setInterval(
        ping,
        HEARTBEAT_MS
      );


    const timeoutId =
      setTimeout(
        function () {
          if (reader) {
            try {
              reader.cancel();
            } catch (e) {
              // ignora
            }
          }
        },
        FETCH_TIMEOUT_MS
      );


    // O evento "close" de IncomingMessage (req) pode ocorrer assim que o
    // corpo do POST termina de ser lido. Não o use para encerrar um SSE longo:
    // isso interrompia respostas válidas no meio e aparecia no frontend como
    // "network error". A vida do stream do cliente é acompanhada pelo res.
    res.on('close', function () {
      // O close emitido depois de res.end() é normal; só cancela se o cliente
      // realmente desconectou antes de o servidor terminar a resposta.
      if (res.writableEnded || closed) return;
      closed = true;
      clearInterval(heartbeatId);
      clearTimeout(timeoutId);
      if (reader) {
        try {
          Promise.resolve(reader.cancel()).catch(function () {});
        } catch (e) {
          // o stream já pode estar cancelado
        }
      }
    });


    // ==========================================================
    // LOOP DE TENTATIVAS "SILENCIOSAS" PARA RESPOSTA VAZIA
    // ==========================================================
    //
    // O modelo pode ocasionalmente terminar um turno sem produzir NENHUM texto
    // visível (finish_reason "stop", mas content vazio e nenhum tool_call
    // novo) — tudo que ele gerou ficou só como reasoning/<think>. Para evitar
    // mostrar diretamente o erro "A IA não retornou uma resposta.", tentamos
    // novamente em silêncio antes de desistir. O streaming de texto real
    // continua acontecendo ao vivo normalmente; só quando uma tentativa
    // termina vazia é que fazemos uma nova chamada por trás dos panos.
    const MAX_EMPTY_RETRIES = 2;

    for (let emptyAttempt = 0; ; emptyAttempt++) {

      const think =
        makeThinkFilter();

      let estimatedThinkingTokens = 0;

      function registerThinking(text) {
        if (!text) return;
        estimatedThinkingTokens += Math.ceil(String(text).length / 4);
      }


      const toolCallsAcc =
        [];


      let contentAcc =
        '';


      let finishReason =
        null;


      let sawAnyChunk =
        false;


      let pendingDelta =
        '';


      let pendingThinking =
        '';

      // Mantemos reasoning_content completo pras próximas rodadas quando tools estão ativas.
      let reasoningContentAcc =
        '';


      let flushTimer =
        null;


      function flushPending() {

        if (
          flushTimer
        ) {
          clearTimeout(
            flushTimer
          );

          flushTimer =
            null;
        }


        if (
          pendingThinking
        ) {
          send({
            type:
              'thinking',

            text:
              pendingThinking
          });

          pendingThinking =
            '';
        }


        if (
          pendingDelta
        ) {
          send({
            type:
              'delta',

            text:
              pendingDelta
          });

          pendingDelta =
            '';
        }
      }


      function scheduleFlush() {
        if (
          flushTimer ||
          closed
        ) {
          return;
        }

        flushTimer =
          setTimeout(
            flushPending,
            FLUSH_MS
          );
      }


      reader =
        upstream
          .body
          .getReader();


      const decoder =
        new TextDecoder();


      let sseBuffer =
        '';


      try {

        while (
          true
        ) {

          const {
            done,
            value
          } =
            await reader.read();


          if (
            done
          ) {
            break;
          }


          sawAnyChunk =
            true;


          sseBuffer +=
            decoder.decode(
              value,
              {
                stream:
                  true
              }
            );

          // SSE pode chegar com LF ou CRLF. Normalizamos apenas as quebras
          // de evento para garantir que reasoning_content/tool_calls sejam
          // processados em streaming através de relays/proxies diferentes.
          sseBuffer = sseBuffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

          let idx;

          while (
            (
              idx =
                sseBuffer.indexOf(
                  '\n\n'
                )
            ) !== -1
          ) {

            const rawEvent =
              sseBuffer.slice(
                0,
                idx
              );


            sseBuffer =
              sseBuffer.slice(
                idx + 2
              );


            const line =
              rawEvent
                .split(
                  '\n'
                )
                .find(
                  function (
                    l
                  ) {
                    return (
                      l.indexOf(
                        'data:'
                      ) ===
                      0
                    );
                  }
                );


            if (!line) {
              continue;
            }


            const dataStr =
              line
                .slice(5)
                .trim();


            if (
              !dataStr ||
              dataStr ===
                '[DONE]'
            ) {
              continue;
            }


            let evt;


            try {
              evt =
                JSON.parse(
                  dataStr
                );
            } catch (
              e
            ) {
              continue;
            }


            const choice =
              evt.choices &&
              evt.choices[0];


            if (!choice) {
              continue;
            }


            const delta =
              choice.delta ||
              {};


            // Step 5 Preview (via NVIDIA) envia reasoning_content no streaming. Alguns
            // relays compatíveis podem normalizar o campo para
            // reasoning/reasoning_text, então aceitamos essas variantes sem
            // depender de <think> dentro do conteúdo visível.
            const reasoningPiece =
              (typeof delta.reasoning_content === 'string' && delta.reasoning_content) ||
              (typeof delta.reasoning === 'string' && delta.reasoning) ||
              (typeof delta.reasoning_text === 'string' && delta.reasoning_text) ||
              '';

            if (reasoningPiece) {
              // Preserve o contexto de reasoning para a continuidade de tool calls,
              // mas só exiba a trilha de pensamento quando "Pensar Mais" estiver ativo.
              reasoningContentAcc += reasoningPiece;
              registerThinking(reasoningPiece);
              if (reasoningEnabled) {
                pendingThinking += reasoningPiece;
                flushPending();
              }
            }


            // content
            if (
              typeof
                delta.content ===
                'string' &&
              delta.content
            ) {

              const parts =
                think.feed(
                  delta.content
                );


              if (parts.thinking) {
                reasoningContentAcc += parts.thinking;
                registerThinking(parts.thinking);
                if (reasoningEnabled) {
                  pendingThinking += parts.thinking;
                  scheduleFlush();
                }
              }


              if (
                parts.visible
              ) {

                contentAcc +=
                  parts.visible;

                pendingDelta +=
                  parts.visible;

                scheduleFlush();
              }
            }


            // tool calls
            if (
              Array.isArray(
                delta.tool_calls
              )
            ) {

              for (
                const tc of
                  delta.tool_calls
              ) {

                const i =
                  typeof
                    tc.index ===
                    'number'
                    ? tc.index
                    : 0;


                if (
                  !toolCallsAcc[i]
                ) {
                  toolCallsAcc[i] = {
                    id:
                      '',

                    type:
                      'function',

                    function: {
                      name:
                        '',

                      arguments:
                        ''
                    }
                  };
                }


                if (
                  tc.id
                ) {
                  toolCallsAcc[i].id =
                    tc.id;
                }


                if (
                  tc.function &&
                  tc.function.name
                ) {
                  toolCallsAcc[i]
                    .function
                    .name +=
                    tc.function.name;
                }


                let streamedToolDelta = false;
                if (
                  tc.function &&
                  typeof
                    tc.function.arguments ===
                      'string'
                ) {
                  toolCallsAcc[i]
                    .function
                    .arguments +=
                    tc.function.arguments;
                  streamedToolDelta = true;
                }

                if (tc.function && tc.function.name) {
                  streamedToolDelta = true;
                }

                if (streamedToolDelta) {
                  send({
                    type: 'tool_delta',
                    index: i,
                    id: tc.id || toolCallsAcc[i].id || '',
                    name: tc.function && tc.function.name
                      ? tc.function.name
                      : toolCallsAcc[i].function.name,
                    arguments: tc.function && typeof tc.function.arguments === 'string'
                      ? tc.function.arguments
                      : ''
                  });
                }
              }
            }


            if (
              choice.finish_reason
            ) {
              finishReason =
                choice.finish_reason;
            }
          }
        }

      } catch (
        err
      ) {

        flushPending();


        send({
          type:
            'error',

          error:
            'Conexão com a IA caiu no meio do streaming: ' +
            (
              err &&
              err.message ||
              err
            )
        });


        finish();

        return;
      }


      // Processa qualquer texto final que o decoder ainda tenha mantido no buffer.
      const decoderRemainder = decoder.decode();
      if (decoderRemainder) {
        sseBuffer += decoderRemainder.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      }

      const leftover =
        think.flushRemainder();


      if (
        leftover.visible
      ) {

        contentAcc +=
          leftover.visible;

        pendingDelta +=
          leftover.visible;
      }


      flushPending();


      if (
        !sawAnyChunk
      ) {

        if (emptyAttempt < MAX_EMPTY_RETRIES) {
          console.warn('[Tato 4.1] Stream vazio (tentativa ' + (emptyAttempt + 1) + '/' + (MAX_EMPTY_RETRIES + 1) + '), tentando de novo silenciosamente.');
          const retryResult = await requestUpstreamWithRetry();
          if (retryResult.fatal || !retryResult.upstream) {
            send({ type: 'error', error: 'A IA não retornou nenhum dado (stream vazio).' });
            finish();
            return;
          }
          upstream = retryResult.upstream;
          continue;
        }

        send({
          type:
            'error',

          error:
            'A IA não retornou nenhum dado (stream vazio).'
        });


        finish();

        return;
      }


      // ==========================================================
      // DEDUPE TOOL CALLS
      // ==========================================================

      function dedupeToolCalls(
        calls
      ) {
        const seen =
          new Set();

        const out =
          [];


        for (
          const tc of
            calls
        ) {

          const key =
            (
              tc.function &&
              tc.function.name ||
              ''
            ) +
            '\u0000' +
            (
              tc.function &&
              tc.function.arguments ||
              ''
            );


          if (
            seen.has(
              key
            )
          ) {
            continue;
          }


          seen.add(
            key
          );


          out.push(
            tc
          );
        }


        return out;
      }


      const cleanToolCalls =
        dedupeToolCalls(
          toolCallsAcc.filter(
            Boolean
          )
        );


      if (
        cleanToolCalls.length
      ) {

        send({
          type:
            'done',

          message: {
            role:
              'assistant',

            content:
              contentAcc ||
              null,

            ...(reasoningContentAcc
              ? { reasoning_content: reasoningContentAcc }
              : {}),

            tool_calls:
              cleanToolCalls
          },

          limitReached:
            false
        });


        finish();

        return;
      }


      // ==========================================================
      // RESPOSTA NORMAL
      // ==========================================================

      let reply =
        contentAcc.trim();


      if (
        !reply
      ) {

        // Resposta veio vazia (só reasoning, sem texto visível e sem
        // tool_calls). Se não foi por ter batido o limite de tokens (esse
        // caso é um problema real de orçamento, não vale retry) e ainda
        // sobrarem tentativas, tenta a mesma requisição de novo em vez de
        // já devolver erro pro usuário — na prática resolve a maioria dos
        // casos, já que é uma falha de geração pontual do modelo.
        if (finishReason !== 'length' && emptyAttempt < MAX_EMPTY_RETRIES) {
          console.warn('[Tato 4.1] Resposta final vazia (tentativa ' + (emptyAttempt + 1) + '/' + (MAX_EMPTY_RETRIES + 1) + '), tentando de novo silenciosamente. finishReason=' + finishReason);
          const retryResult = await requestUpstreamWithRetry();
          if (retryResult.fatal || !retryResult.upstream) {
            send({ type: 'error', error: 'A IA não retornou uma resposta.' });
            finish();
            return;
          }
          upstream = retryResult.upstream;
          continue;
        }

        const reason =
          finishReason ===
            'length'

            ?

          'A IA atingiu o limite de saída desta requisição (' +
          requestMaxTokens.toLocaleString('pt-BR') +
          ' tokens) antes de concluir a resposta.'

            :

          'A IA não retornou uma resposta.';


        send({
          type:
            'error',

          error:
            reason
        });


        finish();

        return;
      }


      let limitReached =
        false;


      if (
        finishReason ===
        'length'
      ) {

        const trimmed =
          trimToSafeBoundary(
            reply
          );


        if (
          trimmed
        ) {
          reply =
            trimmed;
        }


        limitReached =
          true;
      }


      send({
        type:
          'done',

        message: {
          role:
            'assistant',

          content:
            reply,

          ...(reasoningContentAcc
            ? { reasoning_content: reasoningContentAcc }
            : {})
        },

        limitReached:
          limitReached,
        modelMode:
          modelMode,
        reasoningCheckpoint:
          false
      });


      finish();
      return;
    }
  }
);


// ============================================================
// START
// ============================================================

const PORT = Number(process.env.PORT) || 10000;
const HOST = '0.0.0.0';

// Render fica na frente do Node com um proxy HTTP.
// Mantemos conexões longas para o streaming SSE da IA.
const httpServer = app.listen(
  PORT,
  HOST,
  function () {
    console.log(
      'Tato server rodando em http://' +
      HOST + ':' +
      PORT
    );
  }
);

// Evita que o próprio Node encerre conexões longas antes do streaming terminar.
httpServer.keepAliveTimeout = 120000;
httpServer.headersTimeout = 125000;
httpServer.requestTimeout = 0;
httpServer.timeout = 0;
