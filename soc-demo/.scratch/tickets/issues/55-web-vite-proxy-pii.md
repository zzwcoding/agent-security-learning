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

- [ ] vite.config.ts proxy 表含 `/api/v1/pii` 行，写法与相邻行一致
- [ ] 新增静态对账单测绿；人为摘掉该行测试变红（自证有效）后还原
- [ ] `:5173/api/v1/pii/reveal` 真请求非 404（duty_lead 角色 200 / soc1 403，证明已穿透到 agent）
- [ ] web 包全量测试绿、零删除
- [ ] `6-4.md` 文末追加备注（照 2-2.md 票 50 先例）："票 55 修复后 :5173 反查按钮走线已通"，原文正文零改动
- [ ] 手改代码风格与文件现状一致；不碰无关文件

## 实现记录

（待填）
