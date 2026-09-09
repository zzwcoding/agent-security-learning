# 构建上下文是仓库根（pnpm workspace 需要根 lockfile）
FROM node:22-alpine
RUN corepack enable
WORKDIR /app

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml .npmrc ./
COPY services/web/package.json services/web/
RUN pnpm install --frozen-lockfile --filter @soc-demo/web...

# 票 20：fixtures/alerts/ 打包进镜像——回放按钮（FR-M10.1）从构建期 glob 里
# 把 fixture POST 进 ingest webhook 正门（src/fixtures.ts）
COPY fixtures/ fixtures/

# 票 21：eval-results/ 打包进镜像——vite 静态面 /eval-results/latest.json
# （FR-M10.6 Eval 页数据源；vite.config.ts evalResultsStatic 插件读这里）
COPY eval-results/ eval-results/

COPY tsconfig.base.json ./
COPY services/web/ services/web/

WORKDIR /app/services/web
EXPOSE 5173
# 骨架阶段直接跑 vite dev；演示打包优化留到上云阶段
CMD ["pnpm", "dev"]
