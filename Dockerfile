# colibri-rent-book: the API, which also serves the built frontend. Built and published by the CI
# (ghcr.io/mauvaisetroupe/colibri-rent-book, one tag per commit); locally: docker build -t colibri-rent-book .
# Versions are pinned here: Node and Debian. The invoices are read in the browser, by pdf.js (ADR 0013), and the
# supporting PDFs are made by pdfmake and pdf-lib with their own font (ADR 0014): no poppler, no Chromium. Rebuilt
# every month for security updates.

ARG NODE_IMAGE=node:24-trixie-slim

# ---------------------------------------------------------------- frontend: static files
FROM ${NODE_IMAGE} AS frontend
WORKDIR /build/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

# ---------------------------------------------------------------- backend: TypeScript compiled to dist/
FROM ${NODE_IMAGE} AS backend
WORKDIR /build/backend
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY backend/tsconfig.json ./
COPY backend/src ./src
RUN npm run build && npm prune --omit=dev

# ---------------------------------------------------------------- runtime
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    TZ=Europe/Paris

RUN apt-get update \
 && apt-get install -y --no-install-recommends tzdata curl \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app/backend
COPY --from=backend /build/backend/node_modules ./node_modules
COPY --from=backend /build/backend/dist ./dist
COPY backend/package.json ./
COPY backend/schema.sql ./
COPY backend/migrations ./migrations

COPY --from=frontend /build/frontend/dist /app/frontend

# Runs as any non-root user (OpenShift gives an arbitrary uid with group 0): the PDF folder belongs to group 0
RUN mkdir -p /data/pdf && chgrp -R 0 /data && chmod -R g=u /data
USER 1000:0

ENV HOST=0.0.0.0 \
    PORT=3000 \
    STORAGE_DIR=/data/pdf \
    FRONTEND_DIR=/app/frontend
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD curl -fsS http://127.0.0.1:3000/api/health || exit 1
CMD ["node", "dist/server.js"]
