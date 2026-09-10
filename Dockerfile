FROM node:22-bookworm-slim
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
ENV COREPACK_HOME=/opt/corepack
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/persistence/package.json packages/persistence/package.json
COPY packages/providers/package.json packages/providers/package.json
COPY packages/connectors/package.json packages/connectors/package.json
COPY packages/mcp/package.json packages/mcp/package.json
COPY packages/runtime/package.json packages/runtime/package.json
COPY apps/worker/package.json apps/worker/package.json
RUN pnpm install --frozen-lockfile
ENV COREPACK_ENABLE_NETWORK=0
COPY . .
RUN pnpm build && mkdir -p /data/attachments /data/mock && chown -R node:node /data /app/apps/web/.next
USER node
EXPOSE 3000
