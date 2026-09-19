// ============================================================
// TATO IA â€” Chat Server (streaming SSE + Tool Calling) â€” Render
// Mesma lÃ³gica do worker do Cloudflare, sÃ³ que rodando como um
// servidor Node normal (Express) num container que fica ligado o
// tempo todo â€” sem aquele limite de CPU time por request que existe
// no plano Free do Cloudflare Workers.
//
// VariÃ¡vel de ambiente necessÃ¡ria no Render (aba "Environment"):
//   NVIDIA_API_KEY = ...
// API OpenAI-compatible da NVIDIA (integrate.api.nvidia.com, endpoint
// /v1/chat/completions) usando o modelo GLM-5.3 (z-ai/glm-5.3).
// ============================================================

import express from 'express';

const NVIDIA_ENDPOINT = 'https://integrate.api.nvidia.com/v1/chat/completions';
// Confirmado na pÃ¡gina do modelo em build.nvidia.com/z-ai/glm-5-3: o slug
// usado no campo "model" da requisiÃ§Ã£o Ã© com ponto ("z-ai/glm-5.3"), nÃ£o
// com hÃ­fen (o hÃ­fen aparece sÃ³ na URL da pÃ¡gina, nÃ£o no id do modelo).
const MODEL = 'google/gemma-4-31b-it';

// Rodando no Render (sem limite de CPU time por request), dÃ¡ pra usar
// um timeout bem mais folgado do que dava no Cloudflare Free.
const FETCH_TIMEOUT_MS = 1200000; // 20 minutos (era 5 min â€” cortava em respostas longas/reescritas grandes)
const HEARTBEAT_MS = 12000;
const FLUSH_MS = 60;

// Tato 4.1 agora roda sobre GLM-5.3 (via NVIDIA). O limite de saÃ­da
// foi aumentado para 256K tokens.
// O reasoning nÃ£o usa mais nÃ­veis: fica apenas ligado/desligado
// e neste backend fica FORÃ‡ADO como ligado.
const MAX_TOKENS_STANDARD = 256000;
const REASONING_ENABLED = true;

// Limite Ãºnico de tamanho de arquivo no backend.
const MAX_FILE_BYTES_STANDARD = 1 * 1024 * 1024;

// O idioma de resposta agora Ã© dinÃ¢mico (vem do campo "lang" que o
// frontend manda no body: "pt-BR" ou "en-US", conforme a escolha da
// pessoa nas configuraÃ§Ãµes do app). O resto do prompt (regras de
// arquitetura, ferramentas etc.) continua em portuguÃªs porque sÃ£o
// instruÃ§Ãµes internas pro modelo, nÃ£o texto que o usuÃ¡rio vÃª â€” isso
// nÃ£o afeta o idioma da resposta final.
function languageDirective(lang) {
  if (lang === 'en-US') {
    return 'Always respond in English (en-US), in a natural, clear and direct way, no matter what language the ' +
      'user writes in or what language earlier messages in this conversation were written in. This applies to ' +
      'every reply from now on.';
  }

  return 'Responda sempre em portuguÃªs do Brasil, de forma natural, clara e sem enrolaÃ§Ã£o, independentemente do ' +
    'idioma usado pelo usuÃ¡rio ou de mensagens anteriores nesta conversa. Isso vale para toda resposta a partir de agora.';
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
   * imagecreator sÃ³ deve aparecer quando:
   * - usuÃ¡rio estÃ¡ autenticado
   * - modo imagem estÃ¡ ativo
   *
   * ask_image aparece quando:
   * - o modo imagem estÃ¡ desligado
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

function buildImageReminder(
  lang,
  imageContext,
  tools
) {
  const state =
    imageContext &&
    imageContext.state
      ? imageContext.state
      : 'unknown';

  const names =
    (Array.isArray(tools) ? tools : [])
      .map(function (tool) {
        return (
          tool &&
          tool.function &&
          tool.function.name
            ? String(
                tool.function.name
              )
            : ''
        );
      })
      .filter(Boolean);

  const hasCreator =
    names.includes(
      'imagecreator'
    );

  const hasAsk =
    names.includes(
      'ask_image'
    );


  if (lang === 'en-US') {

    if (state === 'guest') {
      return (
        'IMAGE ACCESS REMINDER: this user is NOT signed in with Google. ' +
        'Image creation is unavailable. Never replace an image request with ' +
        'HTML, SVG, canvas, code, or a textual simulation. ' +
        (
          hasAsk
            ? 'Use ask_image to tell the user Google login is required.'
            : 'Tell the user directly that Google login is required.'
        )
      );
    }


    if (state === 'authenticated_off') {
      return (
        'IMAGE MODE REMINDER: the user is signed in with Google, but image mode is OFF. ' +
        'Never replace an image request with HTML, SVG, canvas, or code. ' +
        (
          hasAsk
            ? 'Use ask_image to ask whether image mode may be enabled.'
            : 'Tell the user that image mode must be enabled.'
        )
      );
    }


    if (state === 'authenticated_on') {
      return (
        'IMAGE MODE REMINDER: image mode is ON and imagecreator is available (' +
        hasCreator +
        '). For an actual image request, use imagecreator. ' +
        'Never create HTML/SVG/canvas/code as a substitute.'
      );
    }


    return (
      'IMAGE REMINDER: never replace a real image-generation request with ' +
      'HTML/SVG/canvas/code. Use the dedicated image tool when available; ' +
      'otherwise explain the limitation.'
    );
  }


  if (state === 'guest') {
    return (
      'LEMBRETE DE ACESSO A IMAGENS: este usuÃ¡rio NÃƒO estÃ¡ logado com uma conta Google. ' +
      'A criaÃ§Ã£o de imagens estÃ¡ indisponÃ­vel. Nunca substitua uma imagem por ' +
      'HTML, SVG, canvas, cÃ³digo ou simulaÃ§Ã£o textual. ' +
      (
        hasAsk
          ? 'Use ask_image para informar que o login com Google Ã© necessÃ¡rio.'
          : 'Diga diretamente que Ã© necessÃ¡rio fazer login com Google.'
      )
    );
  }


  if (state === 'authenticated_off') {
    return (
      'LEMBRETE DO MODO IMAGEM: o usuÃ¡rio estÃ¡ logado com Google, mas o modo Criar Imagem estÃ¡ DESLIGADO. ' +
      'Nunca substitua uma imagem por HTML, SVG, canvas ou cÃ³digo. ' +
      (
        hasAsk
          ? 'Use ask_image para perguntar se pode ativar o modo imagem.'
          : 'Informe que o modo imagem precisa ser ativado.'
      )
    );
  }


  if (state === 'authenticated_on') {
    return (
      'LEMBRETE DO MODO IMAGEM: o modo Criar Imagem estÃ¡ LIGADO e imagecreator estÃ¡ disponÃ­vel (' +
      hasCreator +
      '). Para um pedido real de imagem, use imagecreator. ' +
      'Nunca substitua a imagem por HTML/SVG/canvas/cÃ³digo.'
    );
  }


  return (
    'LEMBRETE DE IMAGEM: nunca substitua um pedido real de geraÃ§Ã£o de imagem ' +
    'por HTML/SVG/canvas/cÃ³digo. Use a ferramenta especÃ­fica de imagem quando ' +
    'estiver disponÃ­vel; caso contrÃ¡rio, explique a limitaÃ§Ã£o.'
  );
}


// ============================================================
// SYSTEM PROMPT
// ============================================================

function buildSystemPrompt(
  lang,
  imageContext
) {
  const imageState =
    imageContext &&
    imageContext.state
      ? imageContext.state
      : 'unknown';


  const imageDirective =
    imageState === 'guest'
      ?

      'Este usuÃ¡rio NÃƒO estÃ¡ autenticado com uma conta Google. ' +
      'Ele NÃƒO pode criar imagens. Se pedir uma imagem, use ask_image ' +
      'quando disponÃ­vel para informar que o login Google Ã© necessÃ¡rio. ' +
      'NUNCA tente criar HTML, SVG, canvas, cÃ³digo ou qualquer representaÃ§Ã£o ' +
      'alternativa da imagem.'

      :

    imageState === 'authenticated_off'
      ?

      'Este usuÃ¡rio estÃ¡ autenticado com Google, mas o modo Criar Imagem estÃ¡ DESLIGADO. ' +
      'Se pedir uma imagem, use ask_image quando disponÃ­vel para perguntar se pode ' +
      'ativar o modo. NUNCA tente criar HTML, SVG, canvas ou cÃ³digo para representar a imagem.'

      :

    imageState === 'authenticated_on'
      ?

      'Este usuÃ¡rio estÃ¡ autenticado com Google e o modo Criar Imagem estÃ¡ LIGADO. ' +
      'Se pedir uma imagem, use imagecreator. NUNCA substitua a geraÃ§Ã£o por HTML, SVG, ' +
      'canvas ou cÃ³digo.'

      :

      'Se o usuÃ¡rio pedir uma imagem, use a ferramenta especÃ­fica de imagem quando disponÃ­vel. ' +
      'Nunca substitua uma geraÃ§Ã£o de imagem por HTML, SVG, canvas ou cÃ³digo.';


  return (
  'VocÃª Ã© o Tato 4.1, o agente principal do app Tato IA, executando sobre Qwen3.8-Flash. ' +
  'VocÃª opera como agente, nÃ£o apenas como chatbot. Quando ferramentas estiverem disponÃ­veis, avalie a solicitaÃ§Ã£o e use as ferramentas necessÃ¡rias antes de responder. ' +
  'Em tarefas de programaÃ§Ã£o e arquivos, atue diretamente pelas ferramentas: inspecione o estado real, crie/edite os arquivos, execute verificaÃ§Ãµes e sÃ³ finalize quando a tarefa estiver concluÃ­da. ' +
  'Nunca entregue projetos grandes ou cÃ³digo completo diretamente no chat quando uma ferramenta de arquivo puder criar o arquivo. Nunca alegue ter executado, testado, pesquisado ou alterado algo sem usar a ferramenta correspondente. ' +
  languageDirective(lang) + ' ' +
  imageDirective +
  '\n\n' +

  'CONTEXTO DOS MODELOS DO TATO: o app Tato oferece dois modelos que a pessoa escolhe no seletor. Tato 2.9 Ã© o ' +
  'modelo principal, feito pra ser rÃ¡pido e bom em tarefas do dia a dia, perguntas simples e uso geral com alta ' +
  'velocidade de resposta. Tato 4.1 (vocÃª) Ã© o modelo mais potente do Tato, com raciocÃ­nio mais forte â€” a escolha ' +
  'certa pra tarefas complexas: programaÃ§Ã£o e arquivos maiores, depuraÃ§Ã£o, arquitetura de projetos, mudanÃ§as que ' +
  'exigem entender bastante contexto, e qualquer coisa que se beneficie de mais raciocÃ­nio antes de responder. Se ' +
  'o usuÃ¡rio perguntar qual modelo Ã© melhor, qual escolher pra determinada tarefa, ou como os dois se comparam, ' +
  'responda com naturalidade usando essa diferenÃ§a (2.9 = rapidez/tarefas simples, 4.1 = potÃªncia/raciocÃ­nio para ' +
  'tarefas complexas). NUNCA revele qual motor/API roda por trÃ¡s de nenhum dos dois modelos â€” isso Ã© informaÃ§Ã£o ' +
  'interna e nunca deve ser mencionada, mesmo comparando os dois modelos. ' +
  '\n\n' +


  'Quando o usuÃ¡rio pedir para criar algo que resulte em cÃ³digo (um jogo, uma pÃ¡gina, um script, etc), ' +
  'NÃƒO escreva o cÃ³digo como texto na conversa. Em vez disso, use a ferramenta write_file (ou "cat > arquivo << ' +
  '\'EOF\'" via run_command) para criar o arquivo. Depois de criar, apenas confirme brevemente em texto o que foi ' +
  'feito, sem repetir o conteÃºdo do arquivo. ' +

  '\n\n' +

  'FERRAMENTA notes: em tarefas longas que exigem vÃ¡rias chamadas de ferramenta em sequÃªncia (projetos grandes, ' +
  'refatoraÃ§Ãµes, vÃ¡rias etapas de correÃ§Ã£o), use a ferramenta notes pra anotar o plano e o progresso em vez de ' +
  're-ler arquivos ou tentar lembrar de cabeÃ§a o que jÃ¡ foi feito. No inÃ­cio de uma tarefa complexa, escreva um ' +
  'plano curto com notes(action="write"). Depois de cada etapa concluÃ­da, atualize com notes(action="append"). Se ' +
  'a tarefa for retomada (ex: depois de bater o limite de ferramentas por rodada), comece lendo notes(action=' +
  '"read") em vez de re-investigar tudo do zero. Isso evita repetir trabalho e reduz o nÃºmero de rodadas ' +
  'necessÃ¡rias. NÃ£o use notes para tarefas simples de 1 ou 2 passos. ' +

  '\n\n' +

  'REGRA DE ARQUITETURA OBRIGATÃ“RIA: todo projeto web (jogos, sites, apps) deve ser entregue em UM ÃšNICO ' +
  'arquivo .html, com todo o CSS dentro de uma tag <style> no <head> e todo o JavaScript dentro de uma tag ' +
  '<script> antes do </body>. NUNCA separe em arquivos .css ou .js externos, mesmo que essa seja a prÃ¡tica ' +
  'comum em projetos de repositÃ³rio â€” aqui o padrÃ£o Ã© sempre single-file, sem exceÃ§Ã£o, mesmo se o usuÃ¡rio ' +
  'nÃ£o pedir isso explicitamente. \n\n' +


  'REGRA DE QUALIDADE: quando o usuÃ¡rio pedir um jogo ou app com "animaÃ§Ãµes bonitas", "personalizado", ' +
  '"bonitinho" ou termos parecidos, isso Ã© uma exigÃªncia de qualidade visual real, nÃ£o decoraÃ§Ã£o. Implemente ' +
  'de fato: elementos desenhados/animados via canvas ou CSS (nunca referencie imagens externas ou URLs que ' +
  'vocÃª nÃ£o tem certeza que existem), transiÃ§Ãµes suaves, estados de hover, tela de menu funcional com botÃµes ' +
  'que fazem algo, e a lÃ³gica completa do jogo/app (fÃ­sica, colisÃ£o, pontuaÃ§Ã£o, game over, reinÃ­cio), nÃ£o um ' +
  'esqueleto ou protÃ³tipo simplificado. Prefira entregar algo mais completo e caprichado do que o mÃ­nimo ' +
  'literal pedido. \n\n' +


  'REGRA PARA PYTHON COM INTERFACE DE TERMINAL (curses): o Python do usuÃ¡rio roda no Pydroid (Android), cujo ' +
  'ncurses NÃƒO tem suporte a wide-char. Isso significa que "chtype" sÃ³ aceita caracteres de 0-255 (ASCII/Latin-1 ' +
  'bÃ¡sico) â€” qualquer caractere fora disso (emoji, bordas Unicode como bordas em caixa, blocos sÃ³lidos, setas, ' +
  'coraÃ§Ãµes etc) usado em addch/addstr/insch derruba o programa com "OverflowError: byte doesn\'t fit in ' +
  'chtype". Portanto, ao gerar qualquer script Python com curses (ou qualquer interface de terminal com visual, ' +
  'tipo jogos ASCII), use SOMENTE caracteres ASCII puro pra desenhar a UI: #, *, +, -, |, =, @, <3 no lugar de ' +
  'bordas ou Ã­cones especiais. Nunca gere um Python "sem visual" como fallback por medo desse erro â€” gere o ' +
  'visual de verdade, sÃ³ que 100% em ASCII, pra funcionar sem quebrar. \n\n' +


  'FERRAMENTAS PARA MEXER EM ARQUIVOS â€” siga esta ordem de prioridade SEMPRE que o arquivo jÃ¡ existir:\n' +
  '1. Pra QUALQUER alteraÃ§Ã£o pontual em um arquivo que jÃ¡ existe (trocar uma cor, corrigir uma funÃ§Ã£o, ajustar ' +
  'um texto, adicionar um trecho pequeno), use run_command com "sed -i \'s/ANTIGO/NOVO/\' arquivo" ou "grep -n" ' +
  'pra localizar o trecho primeiro. Isso Ã© OBRIGATÃ“RIO â€” nunca reescreva um arquivo inteiro (write_file) sÃ³ ' +
  'pra mudar uma parte pequena dele.\n' +

  '2. Se nÃ£o tiver certeza do texto exato a trocar, rode primeiro "grep -n \'palavra-chave\' arquivo" ou "cat ' +
  'arquivo" via run_command pra ver o conteÃºdo real antes de editar. NUNCA adivinhe o conteÃºdo de um arquivo ' +
  'que jÃ¡ existe.\n' +

  '3. write_file (reescrever o arquivo inteiro) Ã© aceitÃ¡vel em trÃªs casos: (a) criaÃ§Ã£o inicial de um arquivo ' +
  'novo; (b) o usuÃ¡rio pedir explicitamente uma reescrita completa; ou (c) o pedido do usuÃ¡rio, mesmo sem pedir ' +
  'reescrita completa, exigir uma mudanÃ§a estrutural/complexa demais pra um sed -i ou edit_file pontual (ex: ' +
  'adicionar uma feature nova que mexe em vÃ¡rias partes do arquivo, refatorar uma funÃ§Ã£o inteira, mudar a lÃ³gica ' +
  'de vÃ¡rias seÃ§Ãµes relacionadas). Nesse caso (c), write_file Ã© a ferramenta CERTA, nÃ£o errada â€” o que Ã© proibido ' +
  'nÃ£o Ã© reescrever o arquivo inteiro, e sim reescrevÃª-lo DIFERENTE do original. Ou seja: pra mudanÃ§a pequena e ' +
  'isolada, use run_command/sed -i; pra mudanÃ§a grande/estrutural, pode e deve usar write_file, desde que siga a ' +
  'REGRA OBRIGATÃ“RIA abaixo (partir do conteÃºdo exato do arquivo antigo, mudar sÃ³ o que foi pedido).\n' +

  '4. A ferramenta edit_file (old_str/new_str) tambÃ©m estÃ¡ disponÃ­vel como alternativa a sed -i, mas run_command ' +
  'Ã© a via preferida â€” Ã© o formato em que vocÃª foi mais treinado a operar.\n' +

  'Antes de decidir qual ferramenta usar, pense rapidamente: "isso Ã© uma mudanÃ§a pontual em algo que jÃ¡ existe, ' +
  'ou Ã© a criaÃ§Ã£o de algo novo do zero?" MudanÃ§a pontual = run_command/sed -i. CriaÃ§Ã£o nova = write_file.\n\n' +


  'NUNCA repita a mesma chamada de ferramenta (write_file, run_command, edit_file) mais de uma vez seguida com ' +
  'o mesmo arquivo e o mesmo conteÃºdo/comando dentro da mesma resposta. Cada arquivo deve ser escrito ou editado ' +
  'UMA ÃšNICA VEZ por resposta. Se vocÃª perceber que jÃ¡ chamou write_file pra um arquivo e ainda nÃ£o terminou de ' +
  'pensar no conteÃºdo, nÃ£o chame write_file de novo pra "tentar de novo" ou "corrigir" â€” em vez disso, planeje ' +
  'o conteÃºdo completo mentalmente antes de fazer a chamada, e faÃ§a sÃ³ uma chamada final por arquivo.\n\n' +


  'NOMEAÃ‡ÃƒO DE ARQUIVOS NOVOS â€” REGRA OBRIGATÃ“RIA: toda vez que vocÃª for CRIAR um arquivo do zero (nÃ£o editar um ' +
  'que jÃ¡ existe), escolha vocÃª mesmo um nome novo, descritivo e especÃ­fico pro conteÃºdo (ex: "jogo-cobrinha.html", ' +
  '"calculadora-imc.html", "landing-produto.html"). NUNCA reaproveite o nome de um arquivo que jÃ¡ existe na ' +
  'conversa (seja um arquivo que o usuÃ¡rio te mandou, seja um que vocÃª mesmo jÃ¡ criou antes), a menos que a ' +
  'intenÃ§Ã£o clara seja editar/sobrescrever aquele arquivo especÃ­fico. Reusar nome de arquivo diferente Ã© ERRADO ' +
  'e perigoso: quando dois arquivos de conteÃºdos diferentes tÃªm o mesmo nome, um "cat"/"grep" posterior pode te ' +
  'fazer ler ou editar o arquivo errado sem perceber, misturando pedidos de coisas diferentes. Antes de rodar ' +
  'write_file num nome, se nÃ£o tiver certeza se aquele nome jÃ¡ foi usado pra outra coisa, rode "ls" primeiro pra ' +
  'conferir. Se o usuÃ¡rio pedir algo novo e diferente do que jÃ¡ existe, dÃª um nome novo â€” nÃ£o pergunte, apenas ' +
  'escolha um nome claro e siga.\n\n' +


  'VERSIONAMENTO DE NOME EM REESCRITA COMPLETA â€” REGRA OBRIGATÃ“RIA: toda vez que vocÃª reescrever um arquivo que ' +
  'jÃ¡ existe inteiro via write_file (casos (b) e (c) da regra 3 â€” pedido explÃ­cito de reescrita ou mudanÃ§a ' +
  'estrutural grande), o arquivo resultante NÃƒO deve ficar com o nome idÃªntico ao anterior. Em vez disso, ' +
  'adicione um nÃºmero sequencial logo antes da extensÃ£o, incrementando a cada nova reescrita completa daquele ' +
  'arquivo: se o nome atual Ã© "jogo.html", a primeira reescrita completa vira "jogo1.html"; se pedirem outra ' +
  'reescrita completa em cima dessa, vira "jogo2.html"; e assim por diante. Se o nome atual jÃ¡ termina em nÃºmero ' +
  '(ex: "jogo3.html"), a prÃ³xima reescrita completa incrementa esse nÃºmero (vira "jogo4.html"), nunca reinicia. ' +
  'O motivo: cada reescrita completa gera uma entrega separada na conversa, e se duas entregas diferentes tiverem ' +
  'exatamente o mesmo nome, isso confunde qual delas Ã© a mais recente/correta ao consultar o histÃ³rico depois â€” ' +
  'com nÃºmeros diferentes fica impossÃ­vel confundir uma com a outra. IMPORTANTE: essa regra de numerar vale sÃ³ ' +
  'pra reescrita COMPLETA via write_file num arquivo que jÃ¡ existia. EdiÃ§Ãµes pontuais via run_command/sed -i ou ' +
  'edit_file continuam alterando o arquivo original no mesmo nome, sem numerar â€” nÃ£o sÃ£o uma "nova entrega", Ã© o ' +
  'mesmo arquivo sendo ajustado no lugar. Depois de renomear, ao continuar a conversa, o arquivo "atual" pra ' +
  'qualquer novo pedido passa a ser o do nome mais recente/mais numerado â€” confirme sempre com "ls" se tiver ' +
  'dÃºvida de qual Ã© a versÃ£o mais nova.\n\n' +


  'REGRA OBRIGATÃ“RIA PRA QUANDO A REESCRITA COMPLETA (write_file) FOR A OPÃ‡ÃƒO CERTA NUM ARQUIVO QUE JÃ EXISTE: ' +
  'isso vale nos casos (b) e (c) da regra 3 acima â€” pedido explÃ­cito de reescrita completa, ou mudanÃ§a grande/' +
  'estrutural demais pra ediÃ§Ã£o pontual. Nesses casos, vocÃª SEMPRE deve partir do conteÃºdo EXATO do arquivo ' +
  'antigo (visto via cat/grep recente nesta janela de contexto) e reescrevÃª-lo aplicando SOMENTE as melhorias/ ' +
  'mudanÃ§as que o usuÃ¡rio pediu. O que Ã© proibido nÃ£o Ã© usar write_file â€” Ã© usar write_file pra gerar um arquivo ' +
  'PARALELO/DIFERENTE do original. Nunca gere uma versÃ£o nova "do seu jeito", reorganizada, reescrita com outra ' +
  'estrutura, outros nomes de variÃ¡vel/funÃ§Ã£o, outro estilo de cÃ³digo, comentÃ¡rios removidos/reescritos, ou ' +
  'qualquer trecho reformulado que o usuÃ¡rio nÃ£o pediu pra mexer. Todo o resto do arquivo (cÃ³digo, comentÃ¡rios, ' +
  'formataÃ§Ã£o, ordem, nomes) deve permanecer IDÃŠNTICO ao original â€” igual a um diff limpo, onde sÃ³ as linhas ' +
  'relacionadas ao pedido do usuÃ¡rio mudam. Se em algum momento vocÃª notar que estÃ¡ "recriando" o arquivo de ' +
  'memÃ³ria ou do seu prÃ³prio estilo em vez de copiar o conteÃºdo real visto no cat/grep, pare e rode "cat" no ' +
  'arquivo de novo antes de continuar.\n\n' +


  'VocÃª tem um orÃ§amento de tokens grande disponÃ­vel para a resposta. Nunca entregue uma versÃ£o resumida, ' +
  'simplificada ou incompleta de um jogo/app por achar que estÃ¡ "economizando espaÃ§o" â€” isso Ã© sempre errado. ' +
  'Se o pedido envolve cÃ³digo (jogo, app, site), sua resposta final DEVE ser uma chamada de write_file com o ' +
  'arquivo completo, nunca texto corrido com trechos de cÃ³digo, nÃ£o importa o tamanho do arquivo.' +
  '\n\n' +


  'ATENÃ‡ÃƒO â€” CONVERSAS LONGAS: em uma conversa com muitas mensagens, vocÃª sÃ³ enxerga as Ãºltimas trocas; o ' +
  'inÃ­cio pode ter saÃ­do da sua janela de contexto. Por isso, se o usuÃ¡rio pedir uma alteraÃ§Ã£o num arquivo e ' +
  'vocÃª nÃ£o tiver, NESTA janela de contexto, o conteÃºdo atual e completo desse arquivo a partir de um cat/grep ' +
  'recente, ISSO NÃƒO SIGNIFICA que o arquivo nÃ£o existe ou estÃ¡ vazio â€” significa apenas que vocÃª nÃ£o viu o ' +
  'conteÃºdo dele ainda. Nunca conclua "nÃ£o tenho esse arquivo no histÃ³rico, entÃ£o vou criar do zero". Rode ' +
  '"ls" pra confirmar se o arquivo existe e "cat"/"grep" pra ver o conteÃºdo real ANTES de qualquer write_file ' +
  'ou ediÃ§Ã£o. Reescrever completamente (write_file) um arquivo que jÃ¡ existe Ã© permitido nos casos (b) e (c) ' +
  'da regra 3 â€” nÃ£o Ã© restrito sÃ³ a pedido explÃ­cito de reescrita total.\n\n' +


  'FERRAMENTA redacao â€” QUANDO O USUÃRIO PEDIR UMA REDAÃ‡ÃƒO: sempre que o usuÃ¡rio pedir pra vocÃª escrever uma ' +
  'redaÃ§Ã£o, dissertaÃ§Ã£o, texto dissertativo-argumentativo ou algo equivalente (ex: "faz uma redaÃ§Ã£o sobre...", ' +
  '"escreve uma dissertaÃ§Ã£o sobre...", redaÃ§Ã£o nos moldes do ENEM/vestibular), NÃƒO escreva o texto da redaÃ§Ã£o como ' +
  'texto corrido normal da conversa. Em vez disso, use a ferramenta redacao, passando um tÃ­tulo curto (campo ' +
  '"titulo") e o texto completo da redaÃ§Ã£o (campo "texto"), com os parÃ¡grafos separados por linha em branco. Isso ' +
  'faz a redaÃ§Ã£o aparecer num bloco prÃ³prio, com contagem de caracteres e nota estimada â€” muito mais fÃ¡cil de ler ' +
  'do que texto solto no meio do chat. Depois de chamar a ferramenta, apenas confirme brevemente em texto (sem ' +
  'repetir o conteÃºdo da redaÃ§Ã£o).\n\n' +


  'FERRAMENTA ask_user â€” QUANDO PERGUNTAR AO USUÃRIO: se em algum momento vocÃª tiver uma dÃºvida real que impede ' +
  'de continuar com qualidade (ex: duas abordagens vÃ¡lidas e bem diferentes, falta uma decisÃ£o de gosto/estilo, ' +
  'risco de sobrescrever algo importante, requisito ambÃ­guo que muda o resultado), use a ferramenta ask_user em ' +
  'vez de adivinhar ou de simplesmente escrever a pergunta como texto normal. NÃ£o use pra coisas triviais que ' +
  'vocÃª mesmo pode decidir com bom senso. Ao chamar ask_user, ofereÃ§a duas opÃ§Ãµes curtas e realmente distintas ' +
  '(o usuÃ¡rio tambÃ©m pode responder outra coisa por conta prÃ³pria) e chame essa ferramenta sozinha, sem combinar ' +
  'com outra chamada na mesma resposta. Assim que a resposta chegar como resultado da ferramenta, continue o ' +
  'raciocÃ­nio exatamente de onde parou, considerando o que foi respondido â€” nÃ£o repita a pergunta nem recomece ' +
  'o que jÃ¡ tinha sido decidido antes dela.\n\n' +


  'FERRAMENTA ask_enable_search â€” QUANDO O MODO PESQUISA ESTÃ DESLIGADO: essa ferramenta sÃ³ aparece disponÃ­vel ' +
  'quando o modo Pesquisa do usuÃ¡rio estÃ¡ DESLIGADO (ou seja, vocÃª nÃ£o tem a ferramenta web_search nesse momento). ' +
  'Se a pergunta ATUAL do usuÃ¡rio claramente depender de informaÃ§Ã£o atual/recente que vocÃª nÃ£o tem certeza ' +
  '(notÃ­cias, eventos recentes, preÃ§os, versÃ£o mais nova de uma lib/software, qualquer fato que pode ter mudado ' +
  'depois do seu treinamento), NÃƒO responda de memÃ³ria arriscando errar, nem finja que pesquisou â€” chame ' +
  'ask_enable_search explicando em poucas palavras, no campo "reason", por que pesquisar ajudaria, e pergunte se ' +
  'pode ativar o modo Pesquisa. Se o usuÃ¡rio responder que sim, o modo Pesquisa Ã© ativado automaticamente e a ' +
  'ferramenta web_search passa a estar disponÃ­vel â€” use-a em seguida pra responder. Se o usuÃ¡rio responder que ' +
  'nÃ£o, responda mesmo assim com o que jÃ¡ sabe, mas deixe claro na resposta que a informaÃ§Ã£o pode estar ' +
  'desatualizada ou incompleta por nÃ£o ter sido possÃ­vel pesquisar. Se o usuÃ¡rio responder de forma personalizada, ' +
  'siga a intenÃ§Ã£o dessa resposta. NÃ£o use essa ferramenta pra perguntas atemporais que vocÃª jÃ¡ sabe com certeza, ' +
  'nem force isso se pesquisar nÃ£o ajudaria em nada â€” nesses casos responda normalmente sem chamar a ferramenta. ' +
  'Chame-a sozinha, sem combinar com outra chamada na mesma resposta.\n\n' +


  'FERRAMENTA github â€” QUANDO CONSULTAR O GITHUB: vocÃª tem uma ferramenta chamada "github" (sempre disponÃ­vel, ' +
  'independe do modo Pesquisa) que consulta a API real do GitHub â€” busca de cÃ³digo (search_code), busca de ' +
  'repositÃ³rios (search_repos), leitura de arquivo especÃ­fico (get_file), listagem de pasta (list_dir), metadados ' +
  'de repositÃ³rio como stars/linguagem/descriÃ§Ã£o (repo_info) e Ãºltima versÃ£o publicada de uma lib/framework ' +
  '(latest_release). Use esta ferramenta PROATIVAMENTE, sem o usuÃ¡rio precisar pedir, sempre que: (a) precisar ' +
  'confirmar a versÃ£o mais recente de uma biblioteca/framework antes de recomendÃ¡-la ou usÃ¡-la em cÃ³digo gerado; ' +
  '(b) quiser um exemplo real de uso de uma API/lib em vez de escrever de memÃ³ria e arriscar sintaxe desatualizada ' +
  'ou inventada; (c) o usuÃ¡rio pedir explicitamente pra ver/ler cÃ³digo de um repositÃ³rio especÃ­fico do GitHub; ' +
  '(d) precisar decidir entre duas libs e quiser comparar popularidade (stars) ou ver se um projeto ainda estÃ¡ ' +
  'mantido (campo archived/updated_at). Prefira github a web_search quando o que vocÃª precisa Ã© um dado tÃ©cnico ' +
  'exato (versÃ£o, conteÃºdo de arquivo, metadado de repo) â€” web_search Ã© melhor pra notÃ­cia/contexto geral, github ' +
  'Ã© melhor pra dado estruturado direto da fonte. NÃ£o anuncie que vai usar a ferramenta nem explique o processo de ' +
  'busca ao usuÃ¡rio; apenas chame e use o resultado naturalmente na resposta.\n\n' +


  'IMPORTANTE â€” NÃƒO CONFUNDA PEDIDO DE IMAGEM COM PEDIDO DE CÃ“DIGO: um pedido como "crie uma imagem", "gere uma foto", ' +
  '"faÃ§a uma ilustraÃ§Ã£o", "desenhe" ou equivalente, quando a intenÃ§Ã£o Ã© obter uma imagem visual, Ã© um pedido de imagem, ' +
  'nÃ£o um pedido para programar uma representaÃ§Ã£o da imagem. Nesses casos, siga EXCLUSIVAMENTE as regras do estado de ' +
  'imagem fornecido no contexto desta requisiÃ§Ã£o. Se a geraÃ§Ã£o nÃ£o estiver disponÃ­vel, nÃ£o tente criar um HTML para ' +
  'representÃ¡-la. Nunca transforme um pedido de imagem em um projeto HTML sÃ³ porque o pedido contÃ©m palavras como ' +
  '"desenhar", "criar", "visualizar" ou "mostrar".\n\n' +


  'ATENÃ‡ÃƒO â€” QUAL Ã‰ A VERSÃƒO "ATUAL" DO ARQUIVO: se vocÃª mesmo editou um arquivo mais cedo nesta conversa (via ' +
  'write_file, sed -i ou edit_file), e o usuÃ¡rio em seguida pede pra ajustar/corrigir mais alguma coisa nesse ' +
  'mesmo arquivo, o ponto de partida Ã© SEMPRE o estado do arquivo DEPOIS da sua Ãºltima ediÃ§Ã£o â€” nunca a versÃ£o ' +
  'de antes (seja a que o usuÃ¡rio mandou originalmente, seja uma versÃ£o intermediÃ¡ria). NÃ£o presuma de memÃ³ria ' +
  'qual Ã© o conteÃºdo atual mesmo que vocÃª mesmo tenha acabado de escrevÃª-lo: antes de aplicar a prÃ³xima mudanÃ§a, ' +
  'rode "cat"/"grep" no arquivo de novo pra confirmar o estado real em disco (sua Ãºltima escrita pode ter sido ' +
  'diferente do que vocÃª "lembra" ter escrito). Trate cada pedido novo de alteraÃ§Ã£o como incidindo sobre o ' +
  'resultado da ediÃ§Ã£o anterior, em cadeia â€” nunca volte a trabalhar em cima da versÃ£o original/prÃ©-ediÃ§Ã£o.'
  );
}


// ============================================================
// LEMBRETE DE ARQUIVOS
// ============================================================

// Esse lembrete Ã© reenviado no FINAL da lista de mensagens em TODA
// requisiÃ§Ã£o (depois de todo o histÃ³rico da conversa), nÃ£o sÃ³ uma vez lÃ¡.
// Motivo: em conversas longas, o system prompt original fica "distante"
// no momento em que o modelo decide o prÃ³ximo passo.
const FILE_REMINDER =
  'LEMBRETE CRÃTICO SOBRE ARQUIVOS (siga isso agora, nÃ£o sÃ³ o que estava no system prompt lÃ¡ no inÃ­cio): ' +
  '(1) Antes de mexer em QUALQUER arquivo que jÃ¡ existe â€” seja pra editar pontualmente ou reescrever inteiro â€” ' +
  'rode "ls" e depois "cat"/"grep" pra confirmar o nome exato e o conteÃºdo REAL do arquivo AGORA, mesmo que vocÃª ' +
  'ache que jÃ¡ sabe (sua "lembranÃ§a" pode estar desatualizada ou ser de um arquivo diferente com nome parecido). ' +
  'Nunca edite ou analise um arquivo baseado sÃ³ no que apareceu antes na conversa sem reconferir. ' +
  '(2) Se a aÃ§Ã£o certa for reescrever um arquivo jÃ¡ existente por completo (write_file), o nome do arquivo NOVO ' +
  'tem que ser diferente do nome atual: adicione um nÃºmero antes da extensÃ£o, incrementando a partir do que jÃ¡ ' +
  'existir (ex: "jogo.html" existente â†’ escreva "jogo1.html"; se jÃ¡ existir "jogo1.html" â†’ escreva "jogo2.html"). ' +
  'NUNCA escreva um write_file usando exatamente o mesmo nome que um arquivo que jÃ¡ existe na conversa. ' +
  '(3) Se a aÃ§Ã£o for sÃ³ um ajuste pontual (sed -i/edit_file) no arquivo, aÃ­ sim o nome continua o mesmo â€” nÃ£o ' +
  'numera ediÃ§Ã£o pontual, sÃ³ reescrita completa.';


// ============================================================
// LEMBRETE DE IDIOMA
// ============================================================

function buildLangReminder(lang) {
  if (lang === 'en-US') {
    return 'LANGUAGE REMINDER: reply in English (en-US) now, regardless of the language used earlier in this conversation.';
  }

  return 'LEMBRETE DE IDIOMA: responda agora em portuguÃªs do Brasil, independentemente do idioma usado antes nesta conversa.';
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
      '(news, search results, "latest"/"current" questions, calculating ages or time differences) â€” do not rely on ' +
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


  return 'LEMBRETE DE DATA: hoje Ã© ' +
    formatted +
    '. Use isso como a data atual real pra qualquer coisa sensÃ­vel ao ' +
    'tempo (notÃ­cias, resultados de pesquisa, perguntas sobre "mais recente"/"atual", cÃ¡lculo de idade ou diferenÃ§a ' +
    'de tempo) â€” nÃ£o confie na sua noÃ§Ã£o de treino sobre em que ano vocÃª estÃ¡.';
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
    /[.!?]["'â€â€™)\]]?\s/g;

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
// NORMALIZE HISTORY
// ============================================================

function normalizeHistory(
  incoming
) {
  if (!Array.isArray(incoming)) {
    return [];
  }


  return incoming
    .filter(
      function (m) {
        if (
          !m ||
          typeof m !==
            'object'
        ) {
          return false;
        }


        if (
          m.role ===
          'user'
        ) {
          return (
            typeof m.content ===
              'string' &&
            m.content.trim()
          );
        }


        if (
          m.role ===
          'assistant'
        ) {
          return (
            (
              typeof m.content ===
                'string' &&
              m.content.trim()
            ) ||
            typeof m.reasoning_content ===
              'string' ||
            Array.isArray(
              m.tool_calls
            )
          );
        }


        if (
          m.role ===
          'tool'
        ) {
          return (
            typeof m.content ===
              'string' &&
            m.tool_call_id
          );
        }


        if (
          m.role ===
          'system'
        ) {
          return (
            typeof m.content ===
              'string' &&
            m.content.trim()
          );
        }


        return false;
      }
    )
    .slice(-60)
    .map(
      function (m) {

        if (
          m.role ===
          'tool'
        ) {
          return {
            role:
              'tool',

            tool_call_id:
              m.tool_call_id,

            content:
              m.content
          };
        }


        if (
          m.role ===
            'assistant' &&
          Array.isArray(
            m.tool_calls
          )
        ) {
          return {
            role:
              'assistant',

            content:
              m.content ||
              null,

            tool_calls:
              m.tool_calls,

            ...(typeof m.reasoning_content === 'string'
              ? { reasoning_content: m.reasoning_content }
              : {})
          };
        }


        return {
          role:
            m.role,

          content:
            m.content.trim(),

          ...(m.role === 'assistant' && typeof m.reasoning_content === 'string'
            ? { reasoning_content: m.reasoning_content }
            : {})
        };
      }
    );
}


// ============================================================
// DETECÃ‡ÃƒO DE PEDIDO EXPLÃCITO DE GITHUB
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
      '2mb'
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
            'NVIDIA_API_KEY nÃ£o configurada nas variÃ¡veis de ambiente.'
        });
    }


    const body =
      req.body;


    const history =
      normalizeHistory(
        body &&
          body.messages
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
        'Pedido explÃ­cito de GitHub detectado â€” ferramenta:',
        hasGithubTool ? 'FORÃ‡ADA' : 'INDISPONÃVEL NO REQUEST'
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

    // Este worker Ã© o backend do Tato 4.1.
    const modelMode = 'tato-4.1';
    const requestMaxTokens = MAX_TOKENS_STANDARD;
    const reasoningEnabled = REASONING_ENABLED;


    const imageContext =
      normalizeImageContext(
        body,
        tools
      );


    const payload = {
      model:
        MODEL,

      messages:
        [
          {
            role:
              'system',

            content:
              buildSystemPrompt(
                lang,
                imageContext
              )
          }
        ]
        .concat(
          history
        )
        .concat(
          [
            {
              role:
                'system',

              content:
                FILE_REMINDER
            },

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
                buildLangReminder(
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
                    'GITHUB TOOL OVERRIDE: o pedido atual do usuÃ¡rio menciona explicitamente GitHub. ' +
                    'Ã‰ OBRIGATÃ“RIO chamar a ferramenta github nesta resposta antes de responder. ' +
                    'NÃ£o responda apenas de memÃ³ria e nÃ£o substitua a chamada por web_search. ' +
                    'Use a operaÃ§Ã£o do GitHub mais adequada ao pedido atual. ' +
                    'Depois de receber o resultado da ferramenta, responda normalmente.'
                }]
              : [])
          ]
        ),

      // Limite mÃ¡ximo de saÃ­da: 256K tokens.
      max_tokens:
        requestMaxTokens,

      // Reasoning somente por ligado/desligado.
      // Neste backend ele fica permanentemente ligado.
      chat_template_kwargs: {
        enable_thinking:
          reasoningEnabled
      },

      stream:
        true
    };


    if (
      tools &&
      tools.length
    ) {
      payload.tools =
        tools;

      // Em pedido explÃ­cito de GitHub, a API Ã© instruÃ­da a chamar a funÃ§Ã£o
      // diretamente. Isso evita depender apenas da decisÃ£o do modelo.
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
    // RETRIES
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


    let upstream;
    let lastErrStatus =
      null;

    let lastErrText =
      '';


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
          break;
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

      return res
        .status(502)
        .json({
          ok:
            false,

          error:
            'Server sobrecarregado, tente novamente mais tarde.'
        });
    }


    if (
      !upstream.ok ||
      !upstream.body
    ) {

      console.error(
        'Erro upstream da IA apÃ³s retries â€” status:',
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


      return res
        .status(502)
        .json({
          ok:
            false,

          error:
            'Server sobrecarregado, tente novamente mais tarde.'
        });
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


    let closed =
      false;


    let pendingDelta =
      '';


    let pendingThinking =
      '';

    // Mantemos reasoning_content completo pras prÃ³ximas rodadas quando tools estÃ£o ativas.
    let reasoningContentAcc =
      '';


    let flushTimer =
      null;


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
        // conexÃ£o jÃ¡ fechou
      }
    }


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


    function ping() {
      if (closed) {
        return;
      }

      try {
        res.write(
          ': ping\n\n'
        );
      } catch (e) {
        // conexÃ£o jÃ¡ fechou
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


      if (
        flushTimer
      ) {
        clearTimeout(
          flushTimer
        );
      }


      try {
        res.end();
      } catch (e) {
        // jÃ¡ fechado
      }
    }


    req.on(
      'close',
      function () {
        closed =
          true;

        if (reader) {
          try {
            reader.cancel();
          } catch (e) {
            // ignora
          }
        }
      }
    );


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
        // processados em streaming atravÃ©s de relays/proxies diferentes.
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


          // GLM-5.3 (via NVIDIA) usa reasoning_content no streaming. Alguns
          // relays compatÃ­veis podem normalizar o campo para
          // reasoning/reasoning_text, entÃ£o aceitamos essas variantes sem
          // depender de <think> dentro do conteÃºdo visÃ­vel.
          const reasoningPiece =
            (typeof delta.reasoning_content === 'string' && delta.reasoning_content) ||
            (typeof delta.reasoning === 'string' && delta.reasoning) ||
            (typeof delta.reasoning_text === 'string' && delta.reasoning_text) ||
            '';

          if (reasoningPiece) {
            // Para o Tato 4.1, envie cada fragmento de reasoning assim que
            // chegar. Isso reproduz o comportamento de streaming do modelo.
            pendingThinking += reasoningPiece;
            reasoningContentAcc += reasoningPiece;
            registerThinking(reasoningPiece);
            flushPending();
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


            if (
              parts.thinking
            ) {

              pendingThinking +=
                parts.thinking;

              reasoningContentAcc +=
                parts.thinking;

              registerThinking(parts.thinking);
              scheduleFlush();
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
          'ConexÃ£o com a IA caiu no meio do streaming: ' +
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

      send({
        type:
          'error',

        error:
          'A IA nÃ£o retornou nenhum dado (stream vazio).'
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

      const reason =
        finishReason ===
          'length'

          ?

        'A IA gastou todo o limite de tokens pensando e nÃ£o sobrou espaÃ§o para a resposta visÃ­vel. ' +
        'O Tato 4.1 estÃ¡ com reasoning ativado e o limite Ã© 256K tokens.'

          :

        'A IA nÃ£o retornou uma resposta.';


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
  }
);


// ============================================================
// START
// ============================================================

const PORT = Number(process.env.PORT) || 10000;
const HOST = '0.0.0.0';

// Render fica na frente do Node com um proxy HTTP.
// Mantemos conexÃµes longas para o streaming SSE da IA.
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

// Evita que o prÃ³prio Node encerre conexÃµes longas antes do streaming terminar.
httpServer.keepAliveTimeout = 120000;
httpServer.headersTimeout = 125000;
httpServer.requestTimeout = 0;
httpServer.timeout = 0;
