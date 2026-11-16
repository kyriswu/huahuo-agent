ARG NODE_IMAGE=node:26.12.1-bookworm-slim

FROM ${NODE_IMAGE} AS build
WORKDIR /app

ENV MASTRA_TELEMETRY_DISABLED=1 \
    MASTRA_SKIP_DOTENV=true
RUN npm install --global pnpm@10.15.1

COPY package.json pnpm-lock.yaml .npmrc ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src
COPY skills ./skills
COPY scripts/release/smoke.mjs ./release/smoke.mjs
COPY scripts/release/changes ./release/changes
ARG MASTRA_BUILD_STUDIO=true
RUN export NODE_OPTIONS=--max-old-space-size=768 \
    npm_config_network_concurrency=4 \
    npm_config_child_concurrency=1 \
    && if [ "$MASTRA_BUILD_STUDIO" = "true" ]; then \
        pnpm run build --studio; \
    elif [ "$MASTRA_BUILD_STUDIO" = "false" ]; then \
        pnpm run build; \
    else \
        echo "MASTRA_BUILD_STUDIO must be true or false" >&2; exit 1; \
    fi

FROM ${NODE_IMAGE} AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    APP_ENV=production \
    MASTRA_HOST=0.0.0.0 \
    PORT=4111 \
    MASTRA_TELEMETRY_DISABLED=1

COPY --from=build --chown=node:node /app/.mastra/output/ ./
COPY --from=build --chown=node:node /app/skills/ ./skills/
COPY --from=build --chown=node:node /app/release/ ./release/

USER node
EXPOSE 4111
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || '4111') + '/health', { signal: AbortSignal.timeout(4000) }).then(r => { if (!r.ok) process.exit(1); }).catch(() => process.exit(1))"]

CMD ["node", "index.mjs"]
