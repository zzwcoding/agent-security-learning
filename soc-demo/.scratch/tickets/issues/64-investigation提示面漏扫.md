# 64-investigation提示面漏扫: triage strip 过的注入内容在 investigation 阶段直达 LLM（[J] 第二道兜底，防线换防首实战发现）

**What to build:** 2026-09-12 真网冒烟（票 59 `--real-llm`，幕 2 直球载荷 inject-srcuser）实测发现的 [S] 防线覆盖缺口：①triage 段行为正确——`verdict_llm` 的 guards 扫描 DENIED×2、载荷占位符替换（`workers/triage/flow.ts` inspectUntrusted 模式）；②但流程照走 `investigate_case`，其 LLM 提示面携带的注入内容**没有再被 [S] guards 拦截**（该 run 仅 triage 段 2 条 DENIED，investigation 段零 DENIED），直达椒图被 g6 第二道 `plugin_block`（regex-injection: ignore_previous_instructions/reveal_system_prompt）403 拦下，run 走 fail-closed failed。**双防线兜住、无实际突破，但暴露第一道在 investigation 阶段的提示面覆盖缺口。** 本票两步：研究——investigation prompt 的不可信字段构造 vs triage 的 strip 通道差异（哪个字段/通道带毒上行：case 描述/siem 结果/工具回包/路由分支），产出带 路径:行号 证据的漏扫点定位；修复——investigation 侧补同款 strip/扫描通道（或把漏扫字段纳入既有扫描），守住"[S] 先拦"的第一道语义。

**Touches modules:** `m3`（investigation worker）、`m9`（guards 通道）

**Belongs to spec:** specs/modules.md（m3/m9 卡备注）；证据锚：soc-demo 真网审计（guards_block DENIED×2 仅 triage 段）+ 椒图审计（`DENIED plugin_block`，`client_request_id=launch_run_0efba037-a499-4b98-9911-0d0b749ab55a`，票 16 对账字段首次实战即定位成功）

**Blocked by:** 无

**Status:** ready

**验收：**
- [ ] 研究产物：漏扫通道定位（字段名/文件:行号/带毒上行路径一页纸），注源本票证据链
- [ ] 修复后：同一载荷形态在 investigation 段出现第三次 [S] DENIED（契约级测试锁定，不依赖真网）
- [ ] 双防线语义保持：[J] g6 仍兜底（幕 2 双开断言不动）；fail-closed 纪律不变
- [ ] 全量测试绿只增不减；evals 零回归

**实现记录：**（待填）
