# 29-m11-web-eval-contract: latest.json 契约对齐：Eval 页拦截率真渲染（A1）

**What to build:** 三方形状漂移收口：PRD §6-M11 样例按票 22 实现改写（defense_interception.by_facet/costs）；补「evals 产出→web eval.ts 消费」双端契约测试（fixture 式：latest.json 样例两端共读）；Eval 页攻击面拦截率从「渲染不出」修为真实渲染（含 skipped 不进分母口径）。

**Blocked by:** （无）

**Touches modules:** `m10`, `m11`

**Belongs to spec:** specs/modules.md

**Status:** done

- [x] PRD §6-M11 样例与实现一致（源：对账三-13·已炸集成缺口）
- [x] 双端契约测试：evals 报告形状变更而 web 未跟时必红（源：阶段 7 数据形状契约口径）
- [x] Eval 页三真实渲染：triage_accuracy / defense by_facet 分面计数 / cost 合计（源：FR-M10.6）

## 实现记录（2026-09-09）

- **共享契约样品** `fixtures/eval-report/latest.json`（新建，仿 fixtures/tickets 先例）：latest.json 的唯一权威样例，**由生产者本人生成**——一次性脚手架用 `buildReport` 跑一份合成输入落盘（手抄样品=第三份真相，漂移原样复发）。样例六条用例刻意覆盖：拦截失败 rate 0（chat_injection）、环境 skip 不进 by_face 只留痕（sandbox）、judge evaluable、cost 行。PRD §6-M11 样例按它节选改写（`attack_block_rate`/`cost_csv`/`cases[].name` 旧形状删除，最小改动仅样例块+两行按实现修正说明——票面授权内）。
- **生产端闸** `evals/src/report.contract.test.ts`：同一份合成输入再喂 `buildReport`，过一道 `JSON.stringify`（wire 形）与样品逐字段 deep-equal（run_at 钉成样品固定时刻）。形状一变（改名/换嵌套/加删字段）必红——变异验证：`by_facet`→`by_facets` 红一例后还原。
- **消费端闸** `services/web/src/eval.test.ts`「双端契约」节：`?raw` 导入样品原文（jsdom 里 `import.meta.url` 非 file:，readFileSync 会炸；vite/client 已带类型），喂 `evalView`/`attackFaces` 断言真值（分面键序、0% 如实、sandbox 不在 faces、skipped 留痕、`attack_block_rate` 幽灵键不复活）。变异验证：样品全局改名 defense_intercept → 消费端两红，还原后绿。TDD：消费端先红（`faces=[]`、`hasAttackData=false`，即体检 A1 现状复现）→ 实现后绿。
- **web 消费端对齐**：`api.ts` EvalReport 换 `defense_interception?`（by_face/by_facet/skipped/note）+`costs?`，删 `attack_block_rate`（可选=兼容票 19 旧产物，缺席标未产出不猜数）；`eval.ts` attackFaces 改读 by_face（带分母 total/intercepted），新增 interceptFacets（by_facet 方式计数，FACET_LABELS 四词表）/attackSkipped/defenseNote，未知键原样当标签；`EvalPage.tsx` 攻击面卡真渲染：分面率+`（拦住/分母）`、方式计数 Tag、`分母=ran 攻击用例，skip N 例不计入`+note 原话，成本卡挂 `cost_all.csv N 行`。
- **验证**：check_specs PASS（0 警告）；check_boundary self-test 17/17 + 真仓库 PASS（0 越界）；lint/typecheck 全绿；`pnpm test:eval` 真跑 32 passed 重落产物（by_face 五面/by_facet/costs 15 行与新消费端逐字段咬合）；套件基线不降反升——evals 92→**93**、web 73→**77**。教学：lessons/29-01-latestjson契约对齐与Eval页真渲染.md。
