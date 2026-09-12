# 81-purple-team-eval: 紫队闭环 eval——自主发现率（P2）

**What to build:** 把红队演示（S6）从"打一发拦一下"升级成闭环评估。① 攻击 fixture 驱动：现有 attack fixture（`fixtures/eval/attack/` 11 例）逐例转"假设源"——攻击脚本植入后自动生成对应狩猎假设（webshell 族/C2 族映射表）；② 评估指标**自主发现率**：狩猎循环在预算内自主发现攻击 = 发现（Judge 结论命中 ground truth）；发现不了 = gap_analyzer 产出盲区报告（哪条证据链缺失、哪个工具维度该补）；③ evals scenario 注册（rigs 新布景，收编既有 runner 不重写 worker）；④ 产出两份数字：逐 fixture 发现率表 + 盲区聚类（哪个假设族最弱）——数字进 eval-results/latest.json 与成本 CSV 同口径。

**铁律:** judge 评分不进门槛（既有决策 10 口径）——发现与否的判定用 ground truth 断言，不靠 LLM 自评；紫队闭环只追加 eval 资产，不动防线实现；自主发现率口径写清（预算内/几轮内），防"无上限烧 token 必发现"的注水。

**Touches modules:** `m11`（evals）、`m14`（消费）、`m5`

**Belongs to spec:** specs/orchestration-loop.md（行号回填同上）


**Spec 绑定:** specs/orchestration-loop.md 验收测试表 T23（spec 已定稿 2026-09-12）

**Blocked by:** 79

**Status:** blocked

**验收：**
- [ ] 11 个 attack fixture 全部有对应假设源映射，scenario 全注册
- [ ] 自主发现率逐例可复现（同 seed 同结果），发现判定用 ground truth 断言
- [ ] 盲区报告产出路径走通（未发现例必出缺口分析）
- [ ] 成本口径续上 cost CSV（每例 token/轮数/耗时）
- [ ] 既有 33/33 scenario 零回归

**实现记录：**（待填）
