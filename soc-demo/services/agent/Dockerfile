# 构建上下文是仓库根（pnpm workspace 需要根 lockfile）
FROM node:22-alpine
RUN corepack enable
WORKDIR /app

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml .npmrc ./
COPY services/agent/package.json services/agent/
RUN pnpm install --frozen-lockfile --filter @soc-demo/agent...

COPY tsconfig.base.json ./
COPY services/agent/ services/agent/
# 票 18：chat 只读面 siem_query 的 fixture 语料（FixtureSiem 读 fixtures/alerts/）
COPY fixtures/ fixtures/

WORKDIR /app/services/agent
EXPOSE 3003
CMD ["pnpm", "start"]
