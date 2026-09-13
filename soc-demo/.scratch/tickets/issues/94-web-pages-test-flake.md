# 94-web-pages-test-flake: web vitest 收尾期 Unhandled Error（window is not defined）间歇性把全绿跑挂红（P3）

**What to build:** `services/web` 的 vitest 全量（16 文件/143 用例）**用例本身全过**，但收尾期偶发 `Unhandled Errors: ReferenceError: window is not defined`（源自 `react-dom@19` scheduler 的 `Immediate.performWorkUntilDeadline`，即 react-dom-client.development.js 排进 setImmediate 的渲染活，在 vitest jsdom 环境已 teardown 之后才点火）——unhandled error 计数非零时 vitest 退出码 1，把一次全绿的跑挂红。归属：票 82/92 狩猎页与 Eval 页测试（`src/pages/pages.test.tsx`、`HuntingPage.tsx`、`EvalPage.tsx`，2026-09-13 15:30-15:53 最后修改——先于票 84 的任何写入 16:36+，与票 84 文档改动无关）。修复方向由本票定：受影响用例的异步收尾用 `act()`/flush 排干 scheduler 的 setImmediate，或在 vitest setup 里 teardown 前清空 pending immediates——**不许改生产源码迁就测试**。

**Touches modules:** `m10`（web 测试文件）

**Belongs to spec:** specs/modules.md m10 卡测试计划

**Blocked by:** 无

**Status:** open

**验收：**
- [ ] 连续 ≥10 次 `pnpm test`（services/web）零 unhandled error 且 143 用例全过
- [ ] 不改任何 src/ 生产源码；测试零删除

**实现记录：**（待填）

---

**附：发现时证据（票 84 收尾自证阶段，2026-09-13 16:50-16:57，本机）**

- `services/web` `pnpm test` 四连跑：`Errors 2 errors`（16:50）/ `Errors 2 errors`（16:51）/ **干净 exit 0**（16:55）/ `Errors 1 error`（16:57 全仓递归跑）——间歇性，143/143 用例每次全过。
- 报错原文：`ReferenceError: window is not defined` ❯ react-dom-client.development.js:17920 ❯ scheduler Immediate.performWorkUntilDeadline ❯ processImmediate；vitest 提示 "This error originated in src/pages/pages.test.tsx ... caught after test environment was torn down"。
- 票 84 全程只写 lessons/scenario 文档（首写 16:36），services/web 下零改动；故障源文件 mtime 15:52/15:53 早于其发生观察，属在先遗留。
