# 构建上下文是仓库根（pnpm workspace 需要根 lockfile）
FROM node:22-alpine
RUN corepack enable
WORKDIR /app

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml .npmrc ./
COPY services/case-backend/package.json services/case-backend/
RUN pnpm install --frozen-lockfile --filter @soc-demo/case-backend...

COPY tsconfig.base.json ./
COPY services/case-backend/ services/case-backend/

WORKDIR /app/services/case-backend
EXPOSE 3002
CMD ["pnpm", "start"]
