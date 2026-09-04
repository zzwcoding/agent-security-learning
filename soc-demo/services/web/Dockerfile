# 构建上下文是仓库根（pnpm workspace 需要根 lockfile）
FROM node:22-alpine
RUN corepack enable
WORKDIR /app

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml .npmrc ./
COPY services/web/package.json services/web/
RUN pnpm install --frozen-lockfile --filter @soc-demo/web...

COPY tsconfig.base.json ./
COPY services/web/ services/web/

WORKDIR /app/services/web
EXPOSE 5173
# 骨架阶段直接跑 vite dev；演示打包优化留到上云阶段
CMD ["pnpm", "dev"]
