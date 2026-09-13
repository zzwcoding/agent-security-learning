# 65-chat分类prompt候选硬约束: gate 不可见 deny 分支在真网不可达（防线换防第二发现）

**What to build:** 2026-09-12 真网冒烟（票 59，幕 3）实测的 m8 设计缝隙：`buildClassifyPrompt`（workers/chat/llm.ts:57）硬约束"清单外一律输出 unknown"——soc1 的 isolate_host 按 A.2 矩阵不可见（visible-tools.ts:14"不可见=L2 意图 100% deny 的根源"），**不在候选清单里 → 真分类器永远吐不出它** → gate.ts 的可见性 deny 分支（"角色对工具不可见：A.2 该格为「—」"）在真网是死码。实测：soc1 发"帮我把主机 centos7 隔离了"，真分类落最近可见动作 case_update(0.7) → 闸 require_approval（FR-M8.4 提请语义，安全上仍受闸保护，但语义错位：给值班长推了一张 case_update 审批卡，而用户意图是隔离）。fake 模式测不出：fixture 分类器硬编码 `/隔离|isolate/ → isolate_host`（llm.ts:95），恰好绕过候选约束。修复方向（研究后定）：classify prompt 允许吐出候选外的**高危动作意图**（交闸按可见性裁决——fake fixture 的行为其实就是正确语义），或 A.2 矩阵把高危族对全角色可见+闸 deny；连带 eval chat/03 场景与 intent_classify 的 candidates 语义复核。

**Touches modules:** `m8`（chat classify/gate）

**Belongs to spec:** specs/modules.md（m8 卡）；设计参照 PRD §6-M8 FR-M8.2/M8.4

**Blocked by:** 无

**Status:** done（2026-09-13 当票施工：prompt 契约两清单制 + fake 对齐 + 双腿契约锁，全量/evals/双闸全绿）

**验收：**
- [x] 研究产物：候选约束 vs 可见性 deny 的语义冲突定位一页纸（prompt 行号+A.2 格+gate 分支），含修复方案取舍
- [x] 修复后：真网或契约级可复现——soc1 isolate 意图 → classify 吐 isolate_host → gate deny + "不可见"解释（FR-M8.4 原语义在真网可达）
- [x] fake 全量测试/eval 零回归；intent_gate 审计语义不变（INV-1 fail-closed 不弱化）

**实现记录：**（2026-09-13 施工落盘）

## 一、语义冲突定位一页纸（候选约束 vs 可见性 deny）

**冲突三角（三个 m8 件各自没错，拼起来把 deny 分支焊死）：**

1. **prompt 行号**：`services/agent/workers/chat/llm.ts:57`（修前）——`可选工具清单：${input.candidates}。清单外一律输出 {"tool":"unknown","confidence":0}。`——分类输出被硬约束在 candidates 集合内。
2. **candidates 的来源**：`flow.ts:261`（修前）`candidates: visibleTools(role)`，而 `visible-tools.ts:39-44` 的 VISIBLE_FAMILIES 逐格翻译 A.2——**soc1 行 = 只读查询族 ✓ + 案件写入族 ✓，高危响应族（L2：isolate/block）=「—」，KB 入库 =「提交提案 ✓ / 入库 —」**（docs/prd.md 附录 A.2 第 1262 行，matrix.json roles.soc1 同源）。⇒ soc1 的 candidates 永不含 isolate_host。
3. **gate 分支**：`gate.ts:41-47` 可见性第一收窄——`!visibleTools(role).includes(tool)` → deny「A.2 权限矩阵该格为『—』」。分支本身零 bug。

**串联结论**：输出 ⊆ candidates = 可见集 ⇒ 真分类器在 prompt 约束下**结构上永远吐不出不可见工具** ⇒ gate.ts:41-47 的输入域在真网为空 ⇒ FR-M8.4「越权意图直接拒绝并解释（OpenFGA 裁决）」的真网通路被 prompt 侧截断（票 59 实测：真分类落 case_update(0.7) → require_approval，闸仍保护但语义错位）。fake 测不出：`llm.ts:95` fixture 分类器硬编码 `/隔离|isolate/ → isolate_host`、完全不读 candidates——行为恰好是正确语义，恰好绕过候选约束。

**修复方案取舍（L0 裁定：prompt 侧）：**
- **否决矩阵侧**（高危族对全角色可见+闸 deny）：这是权限面变更——visibleTools 快照（gate.test.ts 快照 diff）、ContextForge Web 下发清单、openfga 元组、m9 对账全部连坐；且**没必要**——闸 deny 三态本就为此设计，A.2 的「—」格语义（不可见=连提请面都没有）是对的，错的只是分类器词汇表被错当成权限面。
- **取 prompt 侧**：分类只是路由建议（INV-3/9 零触碰——命名 isolate_host 不产生任何执行通道，执行仍唯一走审批铸票）；「识别 ≠ 授权」，命名权下放、裁决权留在闸，FR-M8.2「可见性即第一收窄」的口径不变（收窄的是执行与展示面，不是分类器词汇表）。
- **边界**：A.2 权限矩阵与 matrix.json 零改动；visible-tools.ts 只**新增** `highRiskTools()`（从 matrix 单一来源推导 L2 族工具清单，不建第二张表）；gate.ts 消费路径零改动（仅补注释）。

## 二、实现（全部在 m8 workers/chat）

- `visible-tools.ts`：新增 `highRiskTools()` = matrix.json 全部 L2 族工具（kb_write + isolate_host/block_ip/deisolate_host/unblock_ip，与 gate.test.ts L2_TOOLS 同集）——prompt 与 fake 消费同一份。
- `llm.ts`：`ClassifyInput` 增必填 `highRisk`（最小增量；`ClassifyOutput` 零扩展——不需要 deny 预期标记，三态裁决既有代码足够）；`buildClassifyPrompt` 契约改为**两清单制**：「本角色可见工具清单」+「高危动作族清单（即使不在可见清单也要如实识别命名，可见与否意图闸按角色可见性裁决）」+「两份清单都覆盖不了 → unknown」；旧文本「清单外一律输出」退场（有 not.toContain 防回退断言）。
- `llm.ts` FakeChatLlm：与新契约同构对齐——关键词规则产 `hit`，scope 守卫 `hit.tool ∈ candidates ∪ highRisk` 才输出，否则 unknown(0.2)。对齐后 fake 不再「恰好绕过」：红队空可见面问只读 → unknown（契约要求），soc1 问隔离 → isolate_host（高危族许可）。
- `flow.ts`：intent_classify 装配 `highRisk: highRiskTools()`；gate/execute 消费路径零改动。

## 三、契约测试（TDD：先红后绿，红=8 个）

- prompt 契约锁（llm-real.test.ts 票 65 describe）：soc1 真实可见面（18 件、不含 isolate_host）下 prompt 必须含高危动作族清单+isolate_host+「意图闸」说明+unknown 兜底，且不含旧硬约束文本。
- fake 对齐锁（flow.test.ts）：soc1 候选外命名 isolate_host(≥0.5)；红队空可见面两清单外 → unknown(0.2)。
- **全链路双腿契约复现**（flow.test.ts 票 65 describe，不依赖真网）：
  - soc1「帮我把主机 centos7 隔离了」→ llm_call 审计 tool=isolate_host（候选外命名在场）→ denied 事件 reason 含「不可见」「A.2 权限矩阵该格为「—」」→ 零 tool_call 零审批卡 → intent_gate 审计 `{result:DENIED, objectType:intent, details:{role:soc1, tool:isolate_host, decision:deny}}`（五要素不变，INV-1 fail-closed 不弱化）；
  - **对照腿** duty_lead 同消息 → awaiting_approval + approval_required(isolate_host) + intent_gate `{decision:require_approval, result:SUCCESS}`——A.2 矩阵语义未被偷改的直接证据。

## 四、eval 复核（chat/01-04 + intent_classify candidates 逐条声明，预期行为变化处：无）

- chat/01_ip_pivot_readonly：related_alerts 在 soc1 可见清单内 → 全链不受两清单制影响，**零变化**。
- chat/02_soc1_isolate_denied：断言不变（零执行零审批卡 + intent_gate DENIED）；语义增强——classify 命名 isolate_host 由「fake 恰好绕过」变为契约行为，gate 可见性 deny 分支成为唯一 deny 源。yaml 补注释。
- chat/03_unclear_intent_clarify：「今天午饭吃什么」与两清单均不匹配 → 仍 unknown(0.2) → 澄清反问，**零变化**。yaml 补注释。
- chat/04_login_four_roles：visibleTools 各角色快照不动（A.2 未改），**零变化**。yaml 补注释。
- intent_classify 节点（flow.ts）：新增 highRisk 装配一行；llm_call/意图闸审计字段与 action 零改动。

## 五、验证留痕

- services/agent chat 三件套：34/34（修前基线 29/29，新增 5 个契约测试）；TDD 红态 8 失败（highRiskTools 未实现 + fake 无 scope 守卫）→ 实现后全绿。
- 全量 `pnpm test`：evals 10 文件 108 测试 + **evals 33/33 ran/passed/0 failed** + agent 67 文件 696 passed/3 skipped + case-backend 76 + ingest 44+1skipped + web 134 + mcp-audit 14，**全绿**（首跑 web 出现 2 个 react-dom teardown unhandled error 为既有环境竞态 flake，单独重跑 134/134 干净全绿，与本次改动零相关——本票未触 web 任何文件）。
- 双闸：`check_specs.py` PASS（0 警告）；`check_boundary.py` PASS（0 越界，12/12 条禁令全有人查）。`pnpm typecheck` 全仓通过；`pnpm lint` 干净。
- 红线对账：m2/m9/m14/guards 零改动；A.2/matrix.json 零改动；无新框架；无第二套意图闸（gate.ts 消费路径不变）；intent_gate 审计 action/字段不变；全程无 git 操作。

- **L0 验收（主窗口，2026-09-13）**：双闸 PASS + agent 696|3skip + evals 108（33/33 场景）全绿；chat/01-04 eval yaml 语义复核注释核对。设计增量（ClassifyOutput 零扩展，gate 三态既有代码足够）=票面最小增量授权内，接受。收尾五样：spec 无出入 / modules.md 无需同步（m8 卡面语义未变）/ CONTEXT 无新术语 / 施工日志=票面研究一页纸+实现记录 / 架构投影无变更。web 一次 teardown flake（单独重跑 134/134）与既有 flake 观察同款，不另立。

- **独立核验（并行工位，2026-09-13，本票已被 94a4661 完成，仅核验不重复施工）**：实现三处逐一对上实现记录——`llm.ts` 两清单制 prompt（旧文本「清单外一律」仅存于 llm-real.test.ts:98 的 not.toContain 防回退断言）、`visible-tools.ts:71 highRiskTools()`（matrix L2 单一来源）、`flow.ts:265` 装配；gate.ts 仅注释增量，deny 解释文案口径未动；evals 四 yaml 仅注释，断言零改动；matrix.json 不在提交改动清单。复跑：chat 34/34（含票 65 双 describe：soc1 isolate→DENIED「不可见/A.2「—」」+ duty_lead 对照腿 require_approval）；全量 `pnpm test` 六工作区绿（evals 112 + mcp-audit 14 + **agent 69 文件/729+3skipped 与当前基线精确一致** + case-backend 76 + ingest 44+1s + web 143）；evals **33/33 ran/passed/0 failed**；`pnpm typecheck` 全绿。门禁：`check_boundary.py` PASS（0 越界）；`check_specs.py` 1 FAIL——指向并行票 18 工单文件（声明模块 `g1` 未在 specs/modules.md 声明），该文件在本票提交 94a4661 时不存在、由后续 e37c0e4/8d03aad 引入，与本票无关（本票 L0 时双闸 PASS 有据），留并行票 18 自行清偿。