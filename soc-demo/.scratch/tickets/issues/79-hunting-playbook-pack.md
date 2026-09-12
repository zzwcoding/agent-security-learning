# 79-hunting-playbook-pack: 狩猎业务内容包——假设模板 + 菜单子集 + weknora 工具 stub（P1）

**What to build:** 循环的第一个用户（内容层，全票零 m14 机制代码）。① 狩猎假设模板：template_id + 假设句式族（webshell/C2/凭据泄露三族起步）+ 默认菜单子集 + 轮次上限建议；② hunt 版 investigation prompt 模板（plan 起手式按狩猎维度改写，fake LLM 的确定性 plan 覆盖三族假设的拆条路径）；③ weknora 三工具的 **Memory stub 实现**（对接票的占位件，接口形态按票 71 登记的契约）：`playbook_lookup`（查本地剧本库 fixture）、`graph_query`（查本地只读图 fixture）、`hypothesis_register`（L1 写，假设+证据关系落本地 store，人审口径预留 INV-5 对齐位）；④ 三族假设的端到端布景：fixture 假设 + 期望轮次轨迹 + 收敛结论断言（evals scenario 骨架，供票 81 扩展）。

**铁律:** 分层铁律本票兑现——**git diff 不得触及 m14 目录**（review 可查）；stub 是真接口假实现（换 HTTP 实现不换调用方，对齐 MemoryVectorStore 先例）；hypothesis_register 是写工具——票面 L1、审计五要素、走验票闸，禁绕。

**Touches modules:** `m14`（仅消费公开接口）、`m5`、`m2`（stub store）

**Belongs to spec:** specs/orchestration-loop.md（行号回填同上）


**Spec 绑定:** specs/orchestration-loop.md 验收测试表 T01/T07/T08/T22（spec 已定稿 2026-09-12）

**Blocked by:** 74, 78

**Status:** blocked

**验收：**
- [ ] 三族假设 fake LLM 端到端跑通（轮次轨迹与期望一致，断言绿）
- [ ] git diff 不触 m14 目录（架构分层断言，CI 可查）
- [ ] 三 stub 接口契约测试绿（换真实现不换调用方的形态验证）
- [ ] hypothesis_register 验票/审计/票面三件套齐（INV-3/8 断言）
- [ ] 菜单子集外工具被选 100% 拒（planner 约束 + 本票菜单的对账测试）

**实现记录：**（待填）
