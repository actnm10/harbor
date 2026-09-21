FROM node:24-bookworm-slim

ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 DATA_DIR=/data STORAGE_ROOT=/storage
WORKDIR /app
RUN npm install --global pnpm@11.19.0 --ignore-scripts \
    && mkdir -p /data /storage /run/harbor-preview && chown node:node /data /storage /run/harbor-preview
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --prod --frozen-lockfile --ignore-scripts --no-optional
COPY --chown=node:node server.js lib.js admin.js settings.js storage.js file-operations.js archive.js preflight.js preview.js preview-worker.js preview-spreadsheet.js presentation-preview.js ./
COPY --chown=node:node public ./public
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "server.js"]
