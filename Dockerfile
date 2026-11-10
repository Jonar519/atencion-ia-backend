# Imagen de atencion-ia-backend: la MISMA imagen sirve a la API y al worker; cambia solo el comando.
#   API:    node dist/server.js            (CMD por defecto; escucha en PORT, que pone Railway)
#   Worker: node dist/workers/worker.js    (comando de arranque del servicio worker)
# Siempre "node …" directo, nunca "npm start": npm no reenvía SIGTERM y se perdería el apagado
# ordenado (readiness 503 → drenaje → cierre de WebSockets → auditoría pendiente).
# Ninguna variable de entorno ni secreto va en la imagen: los pone la plataforma (Railway).

# Node 24 (el de la CI) sobre Debian 12. Se puede cambiar con --build-arg (misma Debian).
ARG NODE_IMAGE=node:24-bookworm-slim

# ── Build: dependencias completas, cliente de Prisma y TypeScript compilado ──────────────────
FROM ${NODE_IMAGE} AS build
WORKDIR /app
# Prisma necesita OpenSSL para elegir su motor (debian-openssl-3.0.x).
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl \
 && rm -rf /var/lib/apt/lists/*
# Sin NODE_ENV=production aquí: npm ci omitiría las devDependencies (tsc, prisma).
COPY package.json package-lock.json ./
RUN npm ci --no-fund --no-audit
COPY prisma ./prisma
RUN npx prisma generate
COPY tsconfig.json ./
COPY src ./src
RUN npm run build \
 # Quita las devDependencies; el cliente ya generado (node_modules/.prisma) se conserva.
 && npm prune --omit=dev --no-fund --no-audit

# ── Runtime: solo lo necesario para correr, sin root ─────────────────────────────────────────
FROM ${NODE_IMAGE} AS runtime
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
WORKDIR /app
USER node
COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node --from=build /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/dist ./dist
COPY --chown=node:node prisma ./prisma
EXPOSE 4100
CMD ["node", "dist/server.js"]
