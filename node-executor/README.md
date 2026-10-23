# Tato Node Executor (protocolo v1)

Serviço que executa **Node.js real (24.x LTS)** para o `run_command` do Tato IA (`node`, `npm`).
O navegador nunca executa código: o HTML só monta um snapshot validado do TatoFS e chama `POST /v1/run`.

## O que foi verificado (e o que não)
- Testado neste ambiente com Node **v24.22.1**, modo de isolamento **unshare** (rede+PID+mount, uid exclusivo, rlimits): ver "Testes".
- **Não testado**: Render real, imagem Docker, modo `bwrap`, NVIDIA/Agnes. O código do worker antigo (`tatoaiworker-python`) não estava disponível; este serviço é **novo e separado**, o worker de Python/C/Java etc. não foi tocado.

## Isolamento (fail-closed)
No boot o serviço **testa** o sandbox e mostra o resultado em `GET /health`. Ordem: `bwrap` → `unshare` → recusa executar.
Cada execução: uid sem privilégios exclusivo por slot (`setpriv`, `--no-new-privs`), namespace de rede (sem rede), PID e `/proc` próprios, `prlimit` (processos, arquivos, CPU, tamanho de arquivo), ambiente mínimo (nenhum segredo do serviço), workspace temporário 0700, memória vigiada por RSS da árvore, timeout, limite de saída, árvore morta por uid e por cliente que desconecta, limpeza sempre.
**Atenção:** isso exige root com `CAP_SYS_ADMIN`/namespaces no container. Se o host (ex.: Render) não permitir, `/health` mostra `allowed:false` e toda execução é recusada. Só então, se você aceitar o risco, existe `TATO_ALLOW_UNSANDBOXED=1` (sem bloqueio de rede e sem namespaces: **não recomendado**).
Limitações conhecidas: no modo `unshare` o filesystem do container (ex.: `/etc/passwd`, `/usr`) é legível; segredos ficam protegidos por permissões/uid e pelo ambiente mínimo. O `npm install` acessa a internet inteira (sem proxy de registry), mas sem rodar scripts de lifecycle.

## Variáveis de ambiente
| Variável | Padrão | Função |
|---|---|---|
| `FIREBASE_PROJECT_ID` | `tatoiapro` | valida o ID token (aud/iss) |
| `TATO_ALLOWED_ORIGINS` | (vazio = qualquer origem) | CORS; coloque a origem do HTML |
| `TATO_ALLOW_GUESTS` | `1` | `0` exige login; visitante: 6 req/min, sem npm, 10 s, 128 MB |
| `TATO_MAX_CONCURRENCY` | `2` | execuções simultâneas (cada uma ocupa um uid) |
| `TATO_PER_USER_CONCURRENCY` | `2` | por usuário (visitante: 1) |
| `TATO_RATE_USER_PER_MIN` / `TATO_RATE_GUEST_PER_MIN` | `30` / `6` | rate limit |
| `TATO_DEFAULT_TIMEOUT_MS` / `TATO_MAX_TIMEOUT_MS` | `15000` / `60000` | tempo de execução |
| `TATO_INSTALL_TIMEOUT_MS` | `120000` | npm install/ci |
| `TATO_DEFAULT_MEMORY_MB` / `TATO_MAX_MEMORY_MB` | `256` / `512` | memória |
| `TATO_MAX_BODY_BYTES` / `TATO_MAX_TOTAL_BYTES` / `TATO_MAX_FILES` | 10 MiB / 8 MiB / 400 | request e workspace (1 MiB por arquivo, fixo) |
| `TATO_MAX_OUTPUT_BYTES` | 1 MiB | por stream |
| `TATO_CACHE_MAX_BYTES` / `TATO_CACHE_TTL_DAYS` | 1 GiB / 14 | cache de dependências (LRU+TTL) |
| `TATO_NODE_BIN` / `TATO_NPM_CLI` | binário atual / auto | caminhos do Node/npm |
| `TATO_SANDBOX_MODE` | `auto` | `auto`/`bwrap`/`unshare`/`none` |
| `TATO_INSTALL_ENV_PASSTHROUGH` | `NODE_EXTRA_CA_CERTS,SSL_CERT_FILE` | variáveis repassadas SÓ ao npm install |
| `TATO_NPM_REGISTRY` | (padrão npm) | registry alternativo |
| `TATO_INSECURE_NO_AUTH` | — | **só testes locais**; nunca em produção |

Nunca coloque chaves do Supabase/NVIDIA/Firebase Admin neste serviço: ele não precisa de nenhuma.

## Deploy no Render (pelo painel, sem GitHub no celular: use "Public Git Repository"/upload conforme seu fluxo)
1. Novo **Web Service** → runtime **Docker**, raiz = esta pasta (`TatoNodeExecutor`). Plano `starter` ou maior.
2. Variáveis: `FIREBASE_PROJECT_ID`, `TATO_ALLOWED_ORIGINS` (origem do HTML).
3. Deploy; abra `https://SEU-SERVICO.onrender.com/health` e confira `"sandbox":{"mode":"unshare"|"bwrap","allowed":true,"network_blocked":true}`. Se vier `allowed:false`, o Render não permitiu namespaces: use um host que permita (VM/VPS com Docker `--cap-add SYS_ADMIN`) — não force o modo inseguro.
4. No HTML, ajuste `TATO_NODE_EXECUTOR_DEFAULT_URL` (ou, no navegador, `localStorage.setItem('tato_node_executor_url','https://...')`).

## Protocolo v1 — `POST /v1/run`
Pedido: `{version:1, op:'run'|'eval'|'version'|'npm', entrypoint, eval, print, files:[{path,content}], args:[], stdin, npm:{subcommand,script}, limits:{timeout_ms,memory_mb}, writeBack}` (autenticação: `Authorization: Bearer <Firebase ID token>`; sem token = visitante).
Resposta: `{version, status:'success'|'error'|'timeout'|'output_limit'|'memory_limit'|'cancelled'|'rejected', stdout, stderr, exit_code, signal, duration_ms, node_version, timed_out, truncated, cache?, changed_files?}`. Erros de validação: HTTP 4xx `{status:'rejected', code, error}`. Fechar a conexão cancela o job.
Metadados internos do Tato (`.tato_*`) são descartados também no servidor.

## Testes
`TATO_NODE_BIN=/caminho/node24 npm test` (como root, num host com namespaces). 28 testes de serviço + 5 unitários.

## Voltar à versão anterior
Basta usar o HTML original: o `run_command` volta a não ter `node`. O executor pode ser desligado sem afetar o resto do Tato.
