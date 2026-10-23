# Executor Node.js do Tato IA — Node 24 (Active LTS)
FROM node:24-bookworm-slim

# util-linux: setpriv, prlimit, unshare | bubblewrap: raiz mínima opcional
RUN apt-get update \
 && apt-get install -y --no-install-recommends util-linux bubblewrap ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Código do serviço legível só por root (o código do usuário roda com outro uid e não o enxerga)
WORKDIR /opt/tato-executor
COPY package.json server.js ./
COPY lib ./lib
RUN chmod -R go-rwx /opt/tato-executor \
 && mkdir -p /var/tmp/tato-work /var/tmp/tato-cache \
 && chmod 711 /var/tmp/tato-work && chmod 755 /var/tmp/tato-cache

ENV NODE_ENV=production PORT=8080
EXPOSE 8080
# O serviço precisa iniciar como root para trocar de uid por execução (setpriv); o código do usuário nunca roda como root.
CMD ["node", "server.js"]
