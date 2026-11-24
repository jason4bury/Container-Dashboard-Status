# Container Dashboard Status v1.00. Build with: docker build -t jason4bury/container-dashboard-status:1.00 .
# Node.js is pinned to an exact version so every build is the same; bump it here on purpose.
ARG NODE_IMAGE=node:22.23.4-bookworm-slim

# --- Build stage: install production dependencies from package-lock.json ---
FROM ${NODE_IMAGE} AS builder
WORKDIR /app
COPY package.json package-lock.json ./
# --omit=optional skips ssh2's optional native speed-ups, so no build tools are needed.
RUN npm ci --omit=dev --omit=optional

# --- Runtime stage ---
FROM ${NODE_IMAGE}
LABEL org.opencontainers.image.title="Container Dashboard Status" \
      org.opencontainers.image.description="Read-only web page showing the Docker containers on each of your machines, their memory and when they were last updated" \
      org.opencontainers.image.version="1.00" \
      org.opencontainers.image.source="https://github.com/jason4bury/Container-Dashboard-Status" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.authors="Jason Rhodes"
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./
COPY server ./server
COPY public ./public

ENV NODE_ENV=production
EXPOSE 3040

# The machines and SSH key added in Settings.
ENV DATA_DIR=/data
VOLUME ["/data"]

# Backs Docker's own health status with GET /healthz, using Node itself (the slim image has no curl).
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://localhost:'+(process.env.PORT||3040)+'/healthz',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "server/index.js"]
