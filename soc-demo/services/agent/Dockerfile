# 构建上下文是仓库根（pnpm workspace 需要根 lockfile）
FROM node:22-alpine
# better-sqlite3 在 alpine/musl 没有预编译包，pnpm install 现场源码编译要这三件
RUN apk add --no-cache python3 make g++ && corepack enable
WORKDIR /app

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml .npmrc ./
COPY services/agent/package.json services/agent/
# 票 27（agent-guard 狗粮首用）：link:../../../agentjiaotu/packages/agent-guard 相对
# services/agent 解析——镜像内 WORKDIR=/app 时落到容器根 /agentjiaotu/packages/agent-guard。
# 附加上下文 agentjiaotu（compose additional_contexts 挂兄弟仓）在 pnpm install 之前
# COPY 到该解析路径，link: 才不是悬空 symlink（照 jiaotu gateway Dockerfile COPY 包先例）。
COPY --from=agentjiaotu packages/agent-guard /agentjiaotu/packages/agent-guard
RUN pnpm install --frozen-lockfile --filter @soc-demo/agent...

COPY tsconfig.base.json ./
COPY services/agent/ services/agent/
# 票 18：chat 只读面 siem_query 的 fixture 语料（FixtureSiem 读 fixtures/alerts/）
COPY fixtures/ fixtures/

WORKDIR /app/services/agent
EXPOSE 3003
CMD ["pnpm", "start"]
