# 81-purple-team-eval: 紫队闭环 eval——自主发现率（P2）

**What to build:** 把红队演示（S6）从"打一发拦一下"升级成闭环评估。① 攻击 fixture 驱动：现有 attack fixture（`fixtures/eval/attack/` 11 例）逐例转"假设源"——攻击脚本植入后自动生成对应狩猎假设（webshell 族/C2 族映射表）；② 评估指标**自主发现率**：狩猎循环在预算内自主发现攻击 = 发现（Judge 结论命中 ground truth）；发现不了 = gap_analyzer 产出盲区报告（哪条证据链缺失、哪个工具维度该补）；③ evals scenario 注册（rigs 新布景，收编既有 runner 不重写 worker）；④ 产出两份数字：逐 fixture 发现率表 + 盲区聚类（哪个假设族最弱）——数字进 eval-results/latest.json 与成本 CSV 同口径。

**铁律:** judge 评分不进门槛（既有决策 10 口径）——发现与否的判定用 ground truth 断言，不靠 LLM 自评；紫队闭环只追加 eval 资产，不动防线实现；自主发现率口径写清（预算内/几轮内），防"无上限烧 token 必发现"的注水。

**Touches modules:** `m11`（evals）、`m14`（消费）、`m5`

**Belongs to spec:** specs/orchestration-loop.md（行号回填同上）


**Spec 绑定:** specs/orchestration-loop.md 验收测试表 T23（spec 已定稿 2026-09-12）

**Blocked by:** 79

**Status:** done

**验收：**
- [x] 11 个 attack fixture 全部有对应假设源映射，scenario 全注册
- [x] 自主发现率逐例可复现（同 seed 同结果），发现判定用 ground truth 断言
- [x] 盲区报告产出路径走通（未发现例必出缺口分析）
- [x] 成本口径续上 cost CSV（每例 token/轮数/耗时）
- [x] 既有 33/33 scenario 零回归

**实现记录：**（2026-09-13 落，自主档 TDD）

**产物**
- `fixtures/eval/attack/hypothesis-map.json`（①假设源映射表，测试资产）：11 例逐例转狩猎假设——attack 标注/目标/假设族（template_id+pattern_idx+slots 覆盖克隆，形态对齐 fixtures/hunt-templates/）+ ground truth（expected hit|miss、签名三重验口径、逐例 ground truth 注释；hit 例带签名=轨迹执行+取证面 total>0+语料痕迹在场，miss 例带 blind_spot=缺失证据链+该补工具维度）。loader 对非目录项天然跳过，既有 33 条用例清单零扰动。
- `evals/src/rigs/purple.ts`（②③④，spec T23 锚点 `discovery_rate_ground_truth`）：逐 fixture 跑预算内狩猎循环（同 seed 双跑）→ 发现 = judge 结论 hit ∧ ground truth 签名三重验（机器复核，非 LLM 自评；judge 评分零进门槛）；未发现 = 盲区报告（循环 gap_analyzer 真产物 + 映射表缺失链/工具维度）按族聚类。预算口径写死：轮数 ≤ 硬顶 20（票 77 assertRoundsBudget 档）∧ ≤ 模板 max_rounds=6 内容档，loop LLM token ≤ hunt_flow run 档 500k（票 77 分档），cancelled 不冒充发现——防无上限烧 token 注水。边界纪律（R2）：本件零 services 直引，布景组装全部收编 hunting rig（runHuntScene 进程内场景件）——**未扩 R2 允许清单**（豁免是 L0 专属，本票不需要）。
- `evals/src/rigs/hunting.ts`（79/80 直接前件缝上增量）：runFamilyScene 参数化为公开 `runHuntScene(req)`（families/hypothesisId/hypothesisText 可覆盖，缺省行为逐字节同旧档）+ 轨迹机器可复核增量面（rounds_full/taskReports/gapRecords/llm 计费探针/耗时，纯增量）+ hunt-pack 公开面再导出（purple.ts 的唯一 services 消费通道，保 R2 形态）。hunting.test.ts 4 例零回归。
- `evals/src/rigs/purple.test.ts`（TDD 先行）：五测点名八项场景专项检查（映射完备/模板注册/ground truth 对账/hit 签名三重验/miss 盲区报告/预算内/双跑复现/两份数字自洽），并钉死紫队结论快照（发现 5/11 的逐例名单 + credential_leak 族最弱）。
- `evals/src/cli.ts`（公开接口一行）：`pnpm test:eval` 同跑套件与紫队 rig——四工件齐出。
- 产物落盘：`eval-results/purple-team.json`（逐 fixture 发现率表 + 盲区聚类 + 预算口径 + 复现证据 + seed）+ `eval-results/purple-cost.csv`（M507 cost_all.csv 口径 + rounds 列，每例 token/轮数/耗时，hunt 桩 24 tok/次单值计费口径注明，价格同 PRICE_PER_M）。

**验收证据（票面五条）**
- 11 例全映射 + scenario 全注册：purple_map_complete（11/11 目录制逐一对应 + yaml attack 标注同源核对）与 purple_map_templates_registered（template_id 全在 hunt-templates 登记面）双检查绿。
- 逐例可复现 + ground truth 判定：purple_double_run_reproducible（seed=purple-81-v1，逐例双跑决策字段 digest 相等——布景零 RNG）+ purple_ground_truth_discovery（expected↔discovered 11/11 对账）+ purple_hit_signatures_machine_checked（hit 例签名三重验全过）。
- 盲区报告路径走通：purple_miss_blind_spot_reported——6 个未发现例全部出 gap_analyzer 产物（loopGap 非空）+ 缺失证据链 + 该补工具维度。
- 成本口径续上：purple-cost.csv 11 行（case/family/template/model/input/cache_read/output/total_tokens/rounds/duration_ms/est_cost_usd），purple-team.json 内嵌同 rows。
- 既有 33/33 零回归：`pnpm test:eval` 输出 `[eval] 33 ran / 33 passed / 0 failed / 0 skipped`；全量 `pnpm test` 绿（evals 108、agent 689 passed|3 skip、case-backend 76、web 44 passed|1 skip、mcp-audit 111、ingest 14——只增不减）。

**紫队结论**：预算内自主发现 5/11（0.455）——webshell 2/2、ir_host_compromise 2/2、c2_beacon 1/3、**credential_leak 0/4 最弱**（盲区=auth 探测/知识内容/L2 审计/凭证外带四个非 SIEM 工具维度缺失，详见 eval-results/purple-team.json blind_spot_clusters）。

**记入偏差（如实）**
1. latest.json 未并入紫队数字（票面④「进 latest.json」）：票 29 双端契约把 buildReport 形状钉死在共享样例（fixtures/eval-report/latest.json，web 消费端共读）——并入属报告形状变更，会牵动样例与 web 消费端（越出本票「只追加 eval 资产」边界），按红线停：紫队数字以同目录同口径工件族 `eval-results/purple-team.json` 并列（成本 CSV 口径续 M507+rounds）。若 L0 裁定并入 latest.json，需同步双端样例（单独小票）。
2. 「scenario 注册」按 hunting rig 先例落地为 rigs 布景登记（映射完备性机器断言 + rig 函数即 spec T23 锚点 + cli 公开入口接线），未在 scenarios.ts runScenario 开关加无 fixture 驱动的死分支（该开关由 test_case.yaml fixture 驱动，紫队是 rig 级布景非用例级——加 fixture 会扰动 33 条清单口径）。
3. R2 允许清单零扩：purple.ts 经 hunting.ts 再导出面消费 hunt-pack 公开接口，非豁免件零 services 直引（check_boundary PASS 自证）。

- **L0 验收（主窗口，2026-09-13）**：三闸亲跑全 PASS（含零增量自证 6 文件×5 领地交集 0）+ evals 108 passed（33/33 场景零回归）。偏差①（紫队数字并列 purple-team.json 不并入 latest.json）**接受**——latest.json 形状是票 29 双端契约（web 共读），并入=报告形状变更需双端样例同步小票，**列阶段 E 体检候选**（非本战役欠账）；偏差②（rigs 布景登记替代 runScenario 死分支）**接受**。发现率 5/11 与盲区聚类（auth 探测/知识内容/L2 执行审计/凭证外带）为诚实的阴性资产——正是紫队 eval 的产出物，供后续内容层扩工具维度时对账。收尾五样齐。