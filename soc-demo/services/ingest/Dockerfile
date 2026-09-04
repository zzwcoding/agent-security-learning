# 构建上下文是仓库根（pnpm workspace 需要根 lockfile）
FROM node:22-alpine
RUN corepack enable
WORKDIR /app

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml .npmrc ./
COPY services/ingest/package.json services/ingest/
RUN pnpm install --frozen-lockfile --filter @soc-demo/ingest...

COPY tsconfig.base.json ./
COPY services/ingest/ services/ingest/

WORKDIR /app/services/ingest
EXPOSE 3001
CMD ["pnpm", "start"]
