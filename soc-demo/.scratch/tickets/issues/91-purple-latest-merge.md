# 91-purple-latest-merge: 紫队数字并入 latest.json（票 29 双端契约加性扩展）（体检候选②）（P3）

**What to build:** 票 81 偏差①的收口：紫队发现率并入 eval-results/latest.json。① evals 报告装配（buildReport/CLI 汇总处）把 purple rig 的两份数字（逐 fixture 发现率表+盲区聚类）以**加性新字段**并入 latest.json（不改既有字段形状——票 29 双端契约的兼容扩展）；② 共享样例 fixture 双端同步（evals 侧与 web 契约测试样例同更）；③ web Eval 结果页加一小节展示自主发现率（5/11 形态+盲区聚类摘要，展示层最小增量）；④ purple-cost.csv 口径不变（本地工件，不进库）。

**铁律:** 加性扩展零破坏——既有字段一字不动，web 契约测试绿；发现判定仍是 ground truth 断言（决策 10 口径不变）；evals 33/33 零回归。

**Touches modules:** `m11`（evals）、`m10`（web 展示）

**Belongs to spec:** specs/modules.md m10/m11 卡备注面

**Blocked by:** 无

**Status:** ready

**验收：**
- [ ] latest.json 含紫队加性字段，既有字段形状零变化（双端样例同步）
- [ ] web 契约测试绿 + Eval 页展示自主发现率
- [ ] evals 33/33 零回归；全量绿只增不减

**实现记录：**（2026-09-13 落，自主档 TDD）

**产物**
- `evals/src/report.ts`（①报告装配）：`RunReport` 加性可选字段 `purple?: PurpleLatestSummary`（judge 与 cases 之间，缺省不产键——JSON.stringify 落盘即无此键，票 19 时代旧产物零变化）；`buildReport` meta 加 `purple?`，原样嵌入不二次加工。`PurpleLatestSummary` 形状：`{ discovered, fixtures, discovery_rate, per_fixture[], blind_spots[], weakest_family }`——字段名照 rigs/purple.ts 三个结果对象原样（per_fixture=PurpleFixtureResult 的 fixture/family/expected/discovered 四格投影，blind_spots=PurpleCluster 原样），不自造第二套词表；digest/signatures 全文仍归 purple-team.json。
- `evals/src/rigs/purple.ts`（①投影）：新增纯函数 `purpleSummary(report): PurpleLatestSummary`（rig 侧做投影，装配处只接线）；`writePurpleArtifacts` 注释同步（判定逻辑零触碰）。
- `evals/src/suite.test.ts`（①CLI 汇总处接一颗线）：afterAll 先 `discovery_rate_ground_truth()`（进程内确定性桩，~1s）再 `purpleSummary` 进 buildReport；汇总行加 `purple discovery_rate=5/11（盲区聚类 2 族，最弱=…）`。
- `fixtures/eval-report/latest.json`（②双端样例同步）：纯新增 106 行 purple 段（数值=票 81 rig 真实产出的同款投影），既有字段一字未动（git diff 0 删）。
- `services/web/src/api.ts`（③消费契约）：`EvalPurpleSummary/EvalPurpleFixtureRow/EvalPurpleCluster` + `EvalReport.purple?`（可选=兼容旧产物）。
- `services/web/src/eval.ts` + `pages/EvalPage.tsx`（③展示）：`purpleView`（5/11 形态 + 百分比 + 盲区聚类摘要，缺席→null）；Eval 页新小节「紫队闭环 · 自主发现率与盲区聚类」（发现率 45%（5/11）+ 最弱假设族 + 逐族 miss/未发现例/该补工具维度），不引状态管理库，旧产物不渲染该小节。
- 测试（④，只增不减）：evals `report.contract.test.ts`（purple 进双端契约 + 不传不长键）、`report.test.ts`（加性并入/缺省零变化）、`rigs/purple.test.ts`（投影对账）；web `eval.test.ts`（purpleView 单测 + 契约消费端）、`pages.test.tsx`（页面小节真渲染）。

**验收证据**
- latest.json 含紫队加性字段且既有字段形状零变化：真跑 `pnpm test:eval` 后新产物键=旧键+purple，`new.purple == fixture.purple`，totals 33/33 不变。
- web 契约测试绿 + Eval 页展示自主发现率：eval.test.ts/pages.test.tsx 全绿。
- evals 112/112（原 108 + 新 4，33/33 用例零回归）；全量 `pnpm test` EXIT=0 只增不减；typecheck/lint 绿；check:boundary PASS（0 越界 12/12）；check:zero-increment PASS（orchestration/ 零触碰）。purple-cost.csv 口径未动。

**Status:** done（2026-09-13）
