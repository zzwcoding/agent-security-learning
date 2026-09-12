# 75-judge-gap-llm-nodes: judge + gap_analyzer LLM 节点——裁决与缺口（P1）

**What to build:** m14 的收敛判据两件。① judge 节点：读本轮 N 份子报告 → 输出 {结论, 置信度, 证据充分性}；判据schema 化（不许自由文本裁决），置信度低/证据冲突时宁可继续轮次不可提前收敛（fail-closed 口径）；② gap_analyzer 节点：judge 判"不充分"时激活，把缺口翻译成下一轮 planner 输入（"A 主机可疑进程的外联未知"式结构化缺口描述）；③ 两节点的输入（子报告=上游 LLM 产物）同样过注入扫描；④ 防合谋点：judge 不得改写子报告内容，只许引用+裁决（审计留 params_hash 引用痕）。fake/real 双 adapter 同票 74 口径。验收条目逐条源自 spec（票 72 回填行号）。

**铁律:** 框架红线与边界红线同票 74；judge/gap 也不持 L2——收敛结论里若含遏制建议，只是文本建议进 timeline（沿用调查报告 recommended_actions 先例），动作永远走人工审批回路。

**Touches modules:** `m14`、`m5`

**Belongs to spec:** specs/orchestration-loop.md（行号回填同上）

**Blocked by:** 73

**Status:** blocked

**验收：**
- [ ] 证据充分时单轮收敛、不充分时激活 gap→planner 再组合（轮次转换测试绿）
- [ ] 子报告被注入污染时 judge 不采信被污染段（攻击 fixture 断言）
- [ ] judge 只引用不改写（子报告 hash 前后一致断言）
- [ ] fake/real 双 adapter 测试绿
- [ ] 收敛结论落 timeline 为 note 型条目（kind 枚举消费一个空位，INV-8 审计齐）

**实现记录：**（待填）
