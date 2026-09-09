# 29-m11-web-eval-contract: latest.json 契约对齐：Eval 页拦截率真渲染（A1）

**What to build:** 三方形状漂移收口：PRD §6-M11 样例按票 22 实现改写（defense_interception.by_facet/costs）；补「evals 产出→web eval.ts 消费」双端契约测试（fixture 式：latest.json 样例两端共读）；Eval 页攻击面拦截率从「渲染不出」修为真实渲染（含 skipped 不进分母口径）。

**Blocked by:** （无）

**Touches modules:** `m10`, `m11`

**Belongs to spec:** specs/modules.md

**Status:** ready-for-agent

- [ ] PRD §6-M11 样例与实现一致（源：对账三-13·已炸集成缺口）
- [ ] 双端契约测试：evals 报告形状变更而 web 未跟时必红（源：阶段 7 数据形状契约口径）
- [ ] Eval 页三真实渲染：triage_accuracy / defense by_facet 分面计数 / cost 合计（源：FR-M10.6）
