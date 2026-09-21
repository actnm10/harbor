FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      libreoffice-impress python3-uno fonts-crosextra-carlito fonts-crosextra-caladea fonts-liberation2 fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /run/harbor-preview && chown node:node /run/harbor-preview
WORKDIR /renderer
COPY --chown=node:node renderer.js renderer-convert.py ./
ENV NODE_ENV=production PRESENTATION_RENDERER_SOCKET=/run/harbor-preview/renderer.sock
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "require('http').get({socketPath:process.env.PRESENTATION_RENDERER_SOCKET,path:'/healthz'},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"]
CMD ["node", "renderer.js"]
