# #55 · web 反查按钮走线断在 vite proxy 缺行

- Status: open
- Priority: P2
- Discovered: 2026-09-10（场景 6 步 6.4 收官实测，教学导览发现）
- Modules: web

## 缺口解剖

位置：`services/web/vite.config.ts:47-58` —— proxy 转发表没有 `/api/v1/pii` 前缀行。

现象：案件页"反查 PII"按钮调 `api.revealPii`，走同源相对路径 `POST /api/v1/pii/reveal`，经 vite dev 代理（:5173）时无匹配规则、请求落在 vite 自身返回 **404 空 body** —— 浏览器里按钮必失败。且前端 `request` 基座把 404 打包成 `ApiError(404,"unknown")`，`revealErrorText` 的 404 分支误报为"映射表里查不到这个占位符（可能来自 mapstore 建立之前的脱敏）"——**代理断线的 404 与 agent 的 `placeholder_unknown` 404 共用一个文案**，误导排障。

对照组：直连 agent `:3003/api/v1/pii/reveal` 同参数 200 正常（6-3/6-4 实测）。

为什么测试没抓住：web 页面测试跑 jsdom，`fetchMock` 直接拦截 `/api/v1/pii/reveal` 回 200（`pages.test.tsx:516-527`）——**测试替身把代理层整段绕过，单元全绿、走线断裂**。

## 修法（推荐）

1. proxy 表补一行 `"/api/v1/pii": { target: agent, changeOrigin: true }`（与 auth/chat 同款写法）；
2. 补一条**防再犯的静态对账单测**（推荐，比依赖运行中 :5173 的冒烟更 CI 友好）：读 `vite.config.ts` 的 proxy 转发表，断言其前缀集合 ⊇ `web/src` 里 api 基座实际发起的全部 `/api/v1/*` 前缀集合（新增 api 前缀而忘配 proxy 时该测试红）；
3. 手动端到端冒烟验证：对 :5173 的 `/api/v1/pii/reveal` 发真请求断言非 404（修后一次性验证，结果记票）。

## 验收清单

- [x] vite.config.ts proxy 表含 `/api/v1/pii` 行，写法与相邻行一致
- [x] 新增静态对账单测绿；人为摘掉该行测试变红（自证有效）后还原
- [x] `:5173/api/v1/pii/reveal` 真请求非 404（duty_lead 角色 200 / soc1 403，证明已穿透到 agent）（注：:5173 容器镜像烤的是修复前源码、无 bind mount，restart 吃不到新配置——按票内预案改用**同一份修后 vite.config.ts** 的本地临时 dev server :5174 等价验证 200/403，用完即拆；:5173 待主窗口 `docker compose build web && up -d web` 一次即生效，详见实现记录③）
- [x] web 包全量测试绿、零删除（108 → 110，+2 为新增对账测试）
- [x] `6-4.md` 文末追加备注（照 2-2.md 票 50 先例）："票 55 修复后 :5173 反查按钮走线已通"，原文正文零改动
- [x] 手改代码风格与文件现状一致；不碰无关文件

## 实现记录（2026-09-10，修复执行子 agent）

**① proxy 补行**：`vite.config.ts:52` 新增 `"/api/v1/pii": { target: agent, changeOrigin: true },`（events 行与 `/internal` 行之间、agent 组内，写法缩进与相邻行同款），上方分叉规则注释同步补 `pii`（防止注释与表失配）。

**② 静态对账单测**：新增 `services/web/src/vite-proxy.test.ts`（vitest，与既有测试同放 src/、中文头注同风格）。设计：不 mock、不 import 配置模块（vite.config.ts 不在 tsconfig include 内，对账只关心文本），直接读两份源码文本对账——

- 读 `vite.config.ts`，正则抓 proxy 表 `"/…": { target: … }` 形前缀行，取 `/api/v1/*` 行第三段（解析自检：一行都抓不到先红，防空对空放行）；
- `readdir` 递归扫 `src/` 运行时代码（剔除 `*.test.*` 与 `test/` 测试替身），正则抓**带引号**（`'` `"` `` ` ``）的 `/api/v1/<seg>`——引号锚定调用点，注释里的路径不入集（解析自检同上）；
- 断言 api 侧前缀集合 ⊆ proxy 侧。现账：api 9 个（alerts/approvals/audit/auth/cases/chat/events/pii/webhooks）⊆ proxy 9+kb；红时点名缺行前缀。口径：只对账 `/api/v1/*`（`/internal/runs` 走独立 `/internal` 行、`/eval-results` 是静态面非代理，注释里写明不在本闸范围）。
- 实现坑（已在测试头注钉死防"简化"再踩）：`new URL(x, import.meta.url)` 内联写法会被 vite 当静态资产 URL 特征模式改写，jsdom 环境下产物非 file: 协议、`fileURLToPath` 必炸——`import.meta.url` 过一道中间变量即绕开模式匹配。
- **红绿自证**：人为摘掉 `/api/v1/pii` 行 → `AssertionError: expected [ 'pii' ] to deeply equal []`（点名缺行）→ 还原 → 2/2 绿。

**③ 端到端冒烟**（真请求，占位符用 mapstore 教具 `<CN_ID>`）：

- 先按原案 `docker compose restart web`（回 healthy）再对 `:5173/api/v1/pii/reveal` 发真请求 → **仍 404 空 body**。查因（读 docker-compose.yml web 服务 + Dockerfile + `docker inspect`）：web 容器 CMD 是 `pnpm dev`（dev 模式），但源码是构建期 `COPY services/web/` 烤进镜像的、**无 bind mount（Mounts=[]）**——镜像内是修复前配置，restart 不换源码；重建镜像超本票授权（Docker 只许 restart web），按预案转临时 dev server 等价验证。**交接：主窗口跑一次 `docker compose build web && docker compose up -d web`，:5173 即吃到新配置。**
- 临时 dev server（本机 `AGENT_URL=http://127.0.0.1:3003 pnpm exec vite --port 5174 --strictPort`，同一份修后 vite.config.ts，冒烟完 kill、端口已释放）：
  - duty_lead（会话本身也经同一代理 `:5174/api/v1/auth/login` 取得）：`POST :5174/api/v1/pii/reveal {"placeholder":"<CN_ID>"}` → `{"placeholder":"<CN_ID>","originals":["110101199003071234"]} [200]`
  - soc1 同参 → `{"error":"pii_reveal_forbidden"} [403]`
  - 判读：非 404 且响应是 agent 的 JSON body（vite 自身的 404 是空 body）= 已穿透到 agent；200 全链走到 guards/mapstore，403 是 agent 角色白名单的裁决——与 6-3 直连 ：3003 的四角色对照表完全同型。
- 拆除后复点：5174 端口释放、web 容器 healthy，布景零损失。

**④ 全量测试**：`cd soc-demo/services/web && pnpm test` → **15 文件 / 110 passed（0 failed 0 skipped）**，修复前基线实测同命令 108 passed（与 8-5 收官账 web 108 一致）→ 110，只增不减（+2 为新增对账测试，既有测试零删除零改动）；`pnpm typecheck`（tsc --noEmit）exit 0。

改动面：`services/web/vite.config.ts`（+2/-1）、`services/web/src/vite-proxy.test.ts`（新增）；另有授权内文档回填：`6-4.md` 文末备注、`00-导览总纲.md` 学习日志 +1 条与"发现的问题"#55 条目回填。git 零写操作，待主窗口验收后统一提交。
