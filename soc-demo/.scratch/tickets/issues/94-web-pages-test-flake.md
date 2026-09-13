# 94-web-pages-test-flake: web vitest 收尾期 Unhandled Error（window is not defined）间歇性把全绿跑挂红（P3）

**What to build:** `services/web` 的 vitest 全量（16 文件/143 用例）**用例本身全过**，但收尾期偶发 `Unhandled Errors: ReferenceError: window is not defined`（源自 `react-dom@19` scheduler 的 `Immediate.performWorkUntilDeadline`，即 react-dom-client.development.js 排进 setImmediate 的渲染活，在 vitest jsdom 环境已 teardown 之后才点火）——unhandled error 计数非零时 vitest 退出码 1，把一次全绿的跑挂红。归属：票 82/92 狩猎页与 Eval 页测试（`src/pages/pages.test.tsx`、`HuntingPage.tsx`、`EvalPage.tsx`，2026-09-13 15:30-15:53 最后修改——先于票 84 的任何写入 16:36+，与票 84 文档改动无关）。修复方向由本票定：受影响用例的异步收尾用 `act()`/flush 排干 scheduler 的 setImmediate，或在 vitest setup 里 teardown 前清空 pending immediates——**不许改生产源码迁就测试**。

**Touches modules:** `m10`（web 测试文件）

**Belongs to spec:** specs/modules.md m10 卡测试计划

**Blocked by:** 无

**Status:** done（2026-09-13，L2 自主档修复）

**验收：**
- [x] 连续 ≥10 次 `pnpm test`（services/web）零 unhandled error 且 143 用例全过
- [x] 不改任何 src/ 生产源码；测试零删除

**实现记录：**

2026-09-13，按票面方向二（setup 级 teardown 前清空 pending immediates）执行，选型依据与证据：

- **根因链（读本机安装产物定位）**：react-dom@19.2.8 `react-dom-client.development.js:17920` 的延迟提交（IMMEDIATE_COMMIT）把 passive effects 排进 Normal 优先级 scheduler 回调，回调首行 `schedulerEvent = window.event`（ImmediatePriority 的 `processRootScheduleInImmediateTask` 同路）；scheduler@0.27 在**模块求值时**捕获 Node setImmediate（`localSetImmediate → performWorkUntilDeadline`）。文件跑完 jsdom teardown 摘掉 window 后残留 Immediate 一点火即 ReferenceError——与票面报错原文逐字吻合。
- **改动（两个测试领地文件，src/ 生产源码零改动，用例零删除）**：新增 `services/web/src/test/immediate-guard.ts`（包一层 setImmediate/clearImmediate 记 pending 句柄 + afterAll 清空）；`services/web/vite.config.ts` setupFiles 增至 `["src/test/immediate-guard.ts", "src/test/setup.ts"]`（guard 必须首位：setup.ts 首行 antd patch import 会连带求值 react-dom→scheduler，装晚了追不到已捕获的 setImmediate）。
- **选型（afterAll 而非 afterEach）**：scheduler host 回调是「点火→跑完→复位 isMessageLoopRunning」循环活，中途（afterEach）clearImmediate 会把标志位永远卡 true、全文件 scheduleCallback 静默失排——首版实测单跑 pages.test.tsx 红 23/26（A/B 对照摘 guard 26/26 绿，坐实因果），改 afterAll 单点清空后恢复；文件间 immediate 自然跑完（window 在，与修复前行为一致），仅文件收尾清一次，scheduler 实例按文件隔离、收尾后无排程者。
- **验证**：`pnpm typecheck` PASS；`pnpm test`（services/web）**连跑 12 次：12/12 exit 0、143/143 passed、0 unhandled error**（验收线 ≥10 次）；全仓 `pnpm test` exit 0（evals 33/33、mcp-audit 112/112、agent 717+3skip、case-backend 76/76、ingest 44+1skip、web 143/143）只增不减；双闸 `check_specs.py` PASS（0 警告）、`check_boundary.py` PASS（0 越界）。
- **纪律**：无 git 写操作；仅动上述两文件与本票回填。

---

**附：发现时证据（票 84 收尾自证阶段，2026-09-13 16:50-16:57，本机）**

- `services/web` `pnpm test` 四连跑：`Errors 2 errors`（16:50）/ `Errors 2 errors`（16:51）/ **干净 exit 0**（16:55）/ `Errors 1 error`（16:57 全仓递归跑）——间歇性，143/143 用例每次全过。
- 报错原文：`ReferenceError: window is not defined` ❯ react-dom-client.development.js:17920 ❯ scheduler Immediate.performWorkUntilDeadline ❯ processImmediate；vitest 提示 "This error originated in src/pages/pages.test.tsx ... caught after test environment was torn down"。
- 票 84 全程只写 lessons/scenario 文档（首写 16:36），services/web 下零改动；故障源文件 mtime 15:52/15:53 早于其发生观察，属在先遗留。

- **L0 验收（主窗口，2026-09-13）**：双闸 PASS + web 143/143 干净跑复核。afterEach 曲折（中途 clearImmediate 毒化 scheduler isMessageLoopRunning）与 guard 必须列 setupFiles 首位的原因均如实入票——两段都是防回退知识。src/ 生产源码零改动核对（git 清单仅 vite.config.ts+新 setup 件+票面）。收尾五样齐。