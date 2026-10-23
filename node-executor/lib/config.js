'use strict';
// Toda configuração vem de variáveis de ambiente (ver README). Nada de segredo no HTML.
const os = require('os');
const int = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) && n > 0 ? n : d; };

const cfg = {
  PORT: int(process.env.PORT, 8080),
  PROTOCOL_VERSION: 1,
  NODE_BIN: process.env.TATO_NODE_BIN || process.execPath,
  NPM_CLI: process.env.TATO_NPM_CLI || '',            // opcional: caminho do npm-cli.js
  WORK_ROOT: process.env.TATO_WORK_ROOT || '/var/tmp/tato-work',
  CACHE_ROOT: process.env.TATO_CACHE_ROOT || '/var/tmp/tato-cache',
  UID_BASE: int(process.env.TATO_UID_BASE, 41000),     // uid do slot 0; slot N usa UID_BASE+N
  MAX_CONCURRENCY: int(process.env.TATO_MAX_CONCURRENCY, 2),
  PER_PRINCIPAL_CONCURRENCY: int(process.env.TATO_PER_USER_CONCURRENCY, 2),
  GUEST_CONCURRENCY: 1,
  // limites de request/workspace (revalidados no servidor)
  MAX_BODY_BYTES: int(process.env.TATO_MAX_BODY_BYTES, 10 * 1024 * 1024),
  MAX_FILE_BYTES: 1024 * 1024,                         // igual ao TATO_MAX_FILE_BYTES do HTML
  MAX_FILES: int(process.env.TATO_MAX_FILES, 400),
  MAX_TOTAL_BYTES: int(process.env.TATO_MAX_TOTAL_BYTES, 8 * 1024 * 1024),
  MAX_STDIN_BYTES: 100000,
  MAX_ARGS: 64,
  MAX_ARG_LEN: 4096,
  MAX_EVAL_BYTES: 100000,
  MAX_OUTPUT_BYTES: int(process.env.TATO_MAX_OUTPUT_BYTES, 1024 * 1024), // por stream
  // tempo
  DEFAULT_TIMEOUT_MS: int(process.env.TATO_DEFAULT_TIMEOUT_MS, 15000),
  MAX_TIMEOUT_MS: int(process.env.TATO_MAX_TIMEOUT_MS, 60000),
  INSTALL_TIMEOUT_MS: int(process.env.TATO_INSTALL_TIMEOUT_MS, 120000),
  GUEST_MAX_TIMEOUT_MS: 10000,
  // memória (RSS somado da árvore, vigiado) e processos
  DEFAULT_MEMORY_MB: int(process.env.TATO_DEFAULT_MEMORY_MB, 256),
  MAX_MEMORY_MB: int(process.env.TATO_MAX_MEMORY_MB, 512),
  MAX_PROCS: int(process.env.TATO_MAX_PROCS, 64),
  // cache de dependências
  CACHE_MAX_BYTES: int(process.env.TATO_CACHE_MAX_BYTES, 1024 * 1024 * 1024),
  CACHE_TTL_MS: int(process.env.TATO_CACHE_TTL_DAYS, 14) * 86400000,
  INSTALL_ENV_PASSTHROUGH: (process.env.TATO_INSTALL_ENV_PASSTHROUGH || 'NODE_EXTRA_CA_CERTS,SSL_CERT_FILE').split(',').map(x => x.trim()).filter(Boolean),
  NPM_REGISTRY: process.env.TATO_NPM_REGISTRY || '',
  // auth
  FIREBASE_PROJECT_ID: process.env.FIREBASE_PROJECT_ID || 'tatoiapro',
  ALLOW_GUESTS: process.env.TATO_ALLOW_GUESTS !== '0',
  INSECURE_NO_AUTH: process.env.TATO_INSECURE_NO_AUTH === '1', // SÓ para testes locais
  RATE_USER_PER_MIN: int(process.env.TATO_RATE_USER_PER_MIN, 30),
  RATE_GUEST_PER_MIN: int(process.env.TATO_RATE_GUEST_PER_MIN, 6),
  ALLOWED_ORIGINS: (process.env.TATO_ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean),
  // sandbox
  SANDBOX_MODE: process.env.TATO_SANDBOX_MODE || 'auto', // auto | bwrap | unshare | none
  ALLOW_UNSANDBOXED: process.env.TATO_ALLOW_UNSANDBOXED === '1', // NÃO recomendado
  TRUST_PROXY: process.env.TATO_TRUST_PROXY !== '0',     // Render fica atrás de proxy (X-Forwarded-For)
  CPUS: os.cpus().length
};
module.exports = cfg;
