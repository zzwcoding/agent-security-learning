# 65-chat分类prompt候选硬约束: gate 不可见 deny 分支在真网不可达（防线换防第二发现）

**What to build:** 2026-09-12 真网冒烟（票 59，幕 3）实测的 m8 设计缝隙：`buildClassifyPrompt`（workers/chat/llm.ts:57）硬约束"清单外一律输出 unknown"——soc1 的 isolate_host 按 A.2 矩阵不可见（visible-tools.ts:14"不可见=L2 意图 100% deny 的根源"），**不在候选清单里 → 真分类器永远吐不出它** → gate.ts 的可见性 deny 分支（"角色对工具不可见：A.2 该格为「—」"）在真网是死码。实测：soc1 发"帮我把主机 centos7 隔离了"，真分类落最近可见动作 case_update(0.7) → 闸 require_approval（FR-M8.4 提请语义，安全上仍受闸保护，但语义错位：给值班长推了一张 case_update 审批卡，而用户意图是隔离）。fake 模式测不出：fixture 分类器硬编码 `/隔离|isolate/ → isolate_host`（llm.ts:95），恰好绕过候选约束。修复方向（研究后定）：classify prompt 允许吐出候选外的**高危动作意图**（交闸按可见性裁决——fake fixture 的行为其实就是正确语义），或 A.2 矩阵把高危族对全角色可见+闸 deny；连带 eval chat/03 场景与 intent_classify 的 candidates 语义复核。

**Touches modules:** `m8`（chat classify/gate）

**Belongs to spec:** specs/modules.md（m8 卡）；设计参照 PRD §6-M8 FR-M8.2/M8.4

**Blocked by:** 无

**Status:** ready

**验收：**
- [ ] 研究产物：候选约束 vs 可见性 deny 的语义冲突定位一页纸（prompt 行号+A.2 格+gate 分支），含修复方案取舍
- [ ] 修复后：真网或契约级可复现——soc1 isolate 意图 → classify 吐 isolate_host → gate deny + "不可见"解释（FR-M8.4 原语义在真网可达）
- [ ] fake 全量测试/eval 零回归；intent_gate 审计语义不变（INV-1 fail-closed 不弱化）

**实现记录：**（待填）
