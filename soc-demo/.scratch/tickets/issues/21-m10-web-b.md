# 21: m10 Web 下：审批卡 + 时间线 + 对话入口 + Eval 页 + 范围锁死

**What to build:** 收齐六页面：审批卡页（批准/驳回/409 并发）、案件时间线页（含 M8 对话追问入口）、Eval 结果页。路由快照锁死六页面之外无路由；六幕 curl 等价脚本核对。

**Blocked by:** 11, 18, 19, 20

**Touches modules:** `m8`, `m10`, `m11`

**Belongs to spec:** specs/modules.md

**Status:** done

- [x] 审批卡页：pending 列表/批准/驳回 + 实时反馈；并发后到者 409（源：PRD FR-M10.3·异常与边界）
- [x] 案件时间线页：详情 + timeline + 对话追问入口（源：PRD FR-M10.4）
- [x] Eval 结果页：最近一次跑分三维展示（源：PRD FR-M10.6）
- [x] 路由快照：六页面之外无任何路由（源：m10 卡测试计划·决策 #6）
- [x] 六幕剧本每幕同步 curl 等价脚本核对通过（源：m10 卡测试计划·零特权原则）

## 执行记录（票 21 agent，2026-09-09）

- 新增页面/模块：`ApprovalsPage`、`CasePage`（时间线 + 追问抽屉）、`EvalPage`；纯函数层
  `routes.ts` / `approvals.ts` / `timeline.ts` / `chat.ts` / `eval.ts`；`App.tsx` 收敛六页开关。
- 路由快照机器断言三层：`ROUTES` 六行常量被 `routes.test.ts` deep-equal 盯死；`isRouteName`
  表外名字全拒绝；App 壳组件测试断言菜单恰六项 + 表外 hash（#/no_such_page）兜底回告警列表。
- **记票①（Eval 数据源拿法）**：m10/m11 卡均无口径 → 采 vite 静态面：`vite.config.ts` 增加
  `evalResultsStatic` 插件，把 `/eval-results/latest.json`（票 22 起含 cost_all.csv）按磁盘原路径
  静态服务；web Dockerfile 相应 `COPY eval-results/`。不建后端端点，页面只读产物（零特权）。
  票 22 落 attack_block_rate/cost CSV 后本页 `eval.ts` 已按可选字段透传。
- **记票②（六幕脚本的幕 3/4/5 断言口径）**：`scripts/web-smoke-21.sh` 全部走 Web 同源公开面。
  幕 3 以「soc1 发起 L2 对话意图 100% deny 且解释」为公开面等价（worker×工具 403 全矩阵归
  票 22 eval 道）；幕 2/3/4 的 worker 侧 DENIED/审批审计条目当前落 agent ConsoleAuditSink
  （compose logs agent 可见），M2 audit_entries 汇入是后续票 seam——脚本只断言公开 REST/SSE
  可达的页面可见结果（判定不偏/拒绝并解释/卡片翻面+executed 标记）；幕 5 KB 人审按范围锁死
  无对应页面，脚本以 REST 全集等价（提案→驳回→检索面查不到→M2 审计条目）。
- 顺手修正（六幕 Web 全通的前置）：`AlertsPage` 的 AI 分诊列在真实 wire（verdict_ai 为 worker
  原始判定对象，短标签 tp/fp/btp）上会渲染崩——归一为标签映射（长短标签都认），组件测试补真实形状。
- 六幕脚本核对：`bash scripts/web-smoke-21.sh` → 幕 1-6 逐段 PASS，SMOKE PASS
  （布景：lessons/20-01 同款本机最小栈，AGENT_LLM=fake；compose 路径需给 gateway/agent
  注入同一 SOC_HMAC_KEY——compose 网关现无 HMAC 注入，铸票 fail-closed，属环境装配项非本票代码）。
