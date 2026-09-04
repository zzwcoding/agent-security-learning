# 构建上下文是仓库根（pnpm workspace 需要根 lockfile）
FROM node:22-alpine
RUN corepack enable
WORKDIR /app

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml .npmrc ./
COPY services/agent/package.json services/agent/
RUN pnpm install --frozen-lockfile --filter @soc-demo/agent...

COPY tsconfig.base.json ./
COPY services/agent/ services/agent/

WORKDIR /app/services/agent
EXPOSE 3003
CMD ["pnpm", "start"]
