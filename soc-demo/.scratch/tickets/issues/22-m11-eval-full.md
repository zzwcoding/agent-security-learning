# 22: m11 eval 全维 + CI 快慢两道

**What to build:** 补齐攻击/审批/replay/对话维，用例 ≥30；三维报告（分诊准确率/四攻击面拦截率分面计数/成本口径 cost_all.csv）；CI 每日 + 手动全栈 compose 慢道。

**Blocked by:** 14, 15, 16, 17, 18, 19

**Touches modules:** `m11`

**Belongs to spec:** specs/modules.md

**Status:** done

- [x] 用例 ≥30：分诊 ≥10 / 攻击 ≥10（四面）/ 审批 ≥3 / replay ≥2 / 对话 ≥3（源：m11 卡测试计划）
      ——实测 31 条：分诊 11 / 攻击 10（告警注入×4、RAG 投毒、提权×3、沙箱投毒、对话输入注入；四面 A1/A2/A3/沙箱全覆盖）/ 审批 4 / replay 2 / 对话 4。
- [x] 防线拦截率：攻击 fixture 分面计数，拦截=扫描拦或行为兜底 403 分别计（源：PRD FR-M11.4）
      ——`defense_interception.by_facet`：guard_scan 9 / behavior_gate 3 / review_reject 1 / sandbox_boundary 1（D2/D4-D7/D8/沙箱边界各记各账）；by_face 五面 rate 均 1.0；环境 skip 的攻击用例单列 skipped 不进分母。
- [x] 成本口径：每条告警 token/耗时/估算成本，CSV 照 M507 cost_all.csv 列结构（源：PRD FR-M11.4）
      ——`eval-results/cost_all.csv`：case,domain,model,input_tokens,cache_read_tokens,output_tokens,total_tokens,duration_ms,est_cost_usd；token 从 TriageLlm seam 的 UsageProbeLlm 取证（prompt/回包字符按 ~4 字符/token 折算，cache_read 恒 0 留列对齐结构）；估算价目表占位（in $0.3 / out $1.2 每 1M，口径可复核，换真价只改表）。
- [x] CI 快慢两道：PR 快道单测级 <5min；每日 + 手动全栈 compose 慢道（源：决策记录 #10）
      ——快道 ci.yml 未动（evals 已在 `pnpm test` 内，全仓实测 ~14s）；新增 `.github/workflows/eval-slow.yml`（schedule 每日 + workflow_dispatch）：compose up fail-soft → `pnpm test:eval` 全维（确定性门槛硬门禁）→ latest.json + cost_all.csv 归档 artifact → 摘要步把 skip 原因写上 job summary。msb 坏路径实测：`MSB_BIN=/nonexistent-msb` 下沙箱用例显式 skip 留因，套件照绿。
- [x] judge 分数进报告不进门禁（复核）（源：PRD FR-M11.2）
      ——runner.test.ts 钉过 judge 0 分用例照样过；report.test.ts 再钉「judge 全 0 分 → avg_score=0 进报告，passed/failed 纹丝不动」。

**出入记票（实现期决定，均为 eval 格式/测试基建，未动运行时行为）：**

1. §5.11 格式扩两处（格式归 m11 管）：`input.scenario`（第三种 input——审批/replay/沙箱等多步行为布景的具名调用）+ `expected_facet`（攻击用例的预期拦截分面）；`expected_verdict` 只对分诊题（alert_fixture 且无 scenario）必填——对话/审批/replay 硬造 verdict 标注是假数据。
2. attack/07（token_replay）借审批布景演示 INV-2（PRD attack/privesc/03 同语义）；attack/08（L2 提权）走调查 worker 两层真拦（D7 工具面拒 + D4 验票闸 403 强杀）+ 分诊票 × L2 三件 403 横扫（PRD attack/privesc/01 的分诊面）。
3. 根 package.json `test` 加 `--workspace-concurrency=1`：eval 沙箱真跑 VM 与票 16 测试的「机器上无 enrich-* 沙箱」断言在并发下互撞（实测互踩），串行消除该类竞态；全仓 14s，快道 <5min 无虞。
4. replay/01 同 fixture 双推 + replay/02 整目录双遍（scripts/replay.ts 行为契约）都走 ingest webhook 正门 + 真 case-backend SQLite 唯一约束，INV-6 语义（occurrences+1、不重复建案）在真约束上验证。
