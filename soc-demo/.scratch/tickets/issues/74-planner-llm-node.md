# 74-planner-llm-node: planner LLM 节点——拆假设选组合（P1）

**What to build:** m14 的 planner 节点定稿。① prompt 契约落地：输入=假设 + 已有证据 + 缺口描述 + 能力菜单（**只许选 tools.manifest 登记工具，未登记即非法输出**）；输出 schema=任务组合 C_k（任务清单：工具+参数+依据），schema 校验失败走降级（重试一次→仍败置本轮为空组合并落审计，fail-closed 不编造）；② fake adapter（确定性拆条，测试用）+ real adapter（走 llm-client 现有 seam + 凭证代理，真出网开关同现有口径）；③ 防注入：planner 输入里的调查报告（上游 LLM 产物）进 prompt 前过 guards /scan/injection（沿用 investigation 的 scanField 先例）；④ "路由建议 vs 路由决定"分痕：planner 输出落审计（INV-8），但拉子 run 的铸票以决定为准。验收条目逐条源自 spec（票 72 回填行号）。

**铁律:** 框架红线——禁手写 JSON 解析替代 schema 校验（用现有 schema.ts 范式）；边界红线——planner 不持 L2 通道（INV-3），它只输出组合，执行永远是 dispatch 的事。

**Touches modules:** `m14`、`m5`（复用 scan/seam）

**Belongs to spec:** specs/orchestration-loop.md（行号回填同上）

**Blocked by:** 73

**Status:** blocked

**验收：**
- [ ] 输出 schema 校验 + 降级路径测试绿（坏输出不炸 run，落审计）
- [ ] 菜单外工具选择 100% 被拒（断言非法输出不产出子 run）
- [ ] 注入变体报告进 prompt 前被 guards 拦截（攻击 fixture 复用）
- [ ] fake/real 双 adapter 测试绿；real 出网开关语义与现有 LLM 件一致
- [ ] planner 建议/决定审计分痕可查（审计条目两个 action 区分）

**实现记录：**（待填）
