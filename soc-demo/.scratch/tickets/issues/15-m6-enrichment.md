# 15: m6 富化 worker：TLP/PAP 闸门 + analyzer 管线

**What to build:** observables 跑 analyzer（Cortex 契约子集，fixture 表 mock）+ TLP/PAP 确定性闸门 + artifacts 回写。

**Blocked by:** 13

**Touches modules:** `m2`, `m6`, `m9`

**Belongs to spec:** specs/modules.md

**Status:** done

- [x] enrich/01_vt_malicious_hash taxonomy 正确（源：m6 卡测试计划）
- [x] TLP/PAP 闸门在工具包装层确定性执行（不靠 prompt）（源：m6 卡 Seam）
- [x] enrich/02_tlp_red_blocked 超限必拒 + DENIED 审计（源：m6 卡测试计划）
- [x] artifacts 回写 m2（源：m6 卡职责）

## 实现记录（2026-09-08）

落点 `services/agent/workers/enrichment/`：`tools.ts`（ENRICHMENT_TOOLS = A.1 富化三件套 + 共用写 add_timeline_entry，无任何 L2；TOOL_SCHEMAS + validateToolCall——analyzer 两件套 required 即 §6-M6 契约四元组 {data,dataType,tlp,pap}，tlp∈0-4/pap∈0-3 界内整数、dataType 限 §5.3 十类、timeline kind 限 §5.5 枚举）、`analyzers.ts`（ANALYZERS 描述符 max_tlp=2/max_pap=2 一字不差 + tlpPapGate 纯函数闸门 + AnalyzerBackend seam + FixtureAnalyzerTable 情报表 mock：fixtures/ti/<data>.json 命中读文件、未命中 no-record 原文逐字）、`report.ts`（worstLevel 四档序 + renderReportMarkdown：[malicious]/[refused] 评级栏、guards 打标说明、四档图例均可 grep）、`m2.ts`（EnrichmentM2 + HttpEnrichmentM2：案件读/addObservable 回写/timeline 写）、`flow.ts`（三节点子图 load_case→enrich→write_report）。

- 富化是**确定性管线**（无 LLM 决策点）：查什么、按什么顺序、拒绝怎么办全在代码里——m6 卡职责只有「查、闸、回写」。与票 13/14 共享安全骨架：`gated()` 唯一入口过验票闸（任务票 allowed_tools=ENRICHMENT_TOOLS、run 绑定、INV-3 无 L2），闸拒 = 审计 DENIED + 抛错强杀（INV-1）。
- 闸门分层（验收 2）：每个可外发 observable 依次过 ①验票闸（gated）→ ②tlpPapGate 确定性闸门（超 max_tlp/max_pap 即拒，errorMessage 照 PRD §6-M6 拒样例逐字，先 tlp 后 pap、等于 max 放行）→ ③analyzer lookup。闸拒在包装层就地解决：审计 `tlp_pap_denied`（DENIED、actor=agent:enrichment、objectType=analyzer_call、details.error 逐字拒因）+ 报告 results 如实记 refused——**拒绝是工具级结果，run 照常 completed 出报告**（fail-closed ≠ 摊牌）；analyzer 一个字节都没收到（测试用探针包 AnalyzerBackend 断言）。类型外发清单与敏感度闸门两道各管各的：hash/domain/fqdn→vt_lookup、ip→ip_reputation；hostname/filename/url/uri_path/mail/other 属内部实体不外发，计入 skipped_internal 对账栏。
- guards 接线（票 04 语义）：analyzer 输出 = tool_output 通道 → flag 策略——投毒输出放行但打标，审计 `tool_output_flagged`（objectType=analyzer_output），报告原文保留 + guards 标记待人工复核（第四攻击面的内容半边，票 16 切沙箱真跑）。
- m2 侧改动（验收 4）：`POST /api/v1/cases/:id/observables`（store.addCaseObservable）——按 (case_id, dataType, data) 去重合并：命中不建行，tags 去重并入（旧在前）、message 仅原空时回填，HTTP 面 201 新建/200 合并对齐 ingest 口径，缺 dataType/data 400；审计同事务记 diff（INV-8）。重放幂等：整案重富化第二次 artifacts 全 dedup、observables 不膨胀、报告照写。
- 评测布景：m6 卡测试计划引用的 enrich/01、enrich/02 具名 fixture 属 evals/（m11 范围），按票 13/14 先例用既有 fixture（vt-87105-malware / ssh-5712-real）+ 种子复现同一布景；测试名与断言逐条对表。

### 出入与偏差记录（不改 spec 本体）

1. **遗留测试笔误修正（pap 越界样例）**：前一窗口留下的 contract.test.ts 用 `pap: 3` 当「pap 越界」样例，但 PRD §5.3 PAP 枚举是 0-3（上限 3），pap=3 是合法签名、必须放它到闸门层被 `pap_exceeded` 拒——与本文件「tlp=4 签名合法，拒它是闸门的活」的分层原则及 analyzers 组 pap_exceeded 用例一致。已把样例改为 `pap: 4` 并注明；实现按枚举界 tlp 0-4 / pap 0-3 把关。
2. **TLP:RED（tlp=4）observable 无法从现行管道进案**：m1 映射与 REST 建案只产 tlp=2 的 observable，enrich/02 布景需要 tlp=4 的数据——测试经 `CaseBackend.db` 句柄直接种库（testkit 同票加的口子）。属 m1 映射面缺口（与票 14 记的 m1 出入同源），勿越界修；evals/（m11）落具名 fixture 时如需真 tlp=4 告警，须先给 m1 补 TLP 溯源。
3. **testkit 补 hash 抽取**：`alertInputFromWazuh`（测试布景映射 stub）此前漏了 syscheck hash 字段，vt-87105 的 sha256_after 进不了案、富化无从查起——按 ingest wazuh.ts 的 HASH_FIELD 同款正则补齐。这是测试 stub 与真 m1 映射的对齐，不是 m1 本体改动。
4. **富化子图未接 index.ts 组图**：现行 AGENT_FLOW 默认图是 triage 子图（票 13），case_flow 的完整编排（TP→调查→富化→沉淀）属 m3 编排票；本票子图以 `makeEnrichmentFlow({case_id, ticket, ...})` 工厂交付（m6 卡公开接口形态），测试直接打工厂 + 真 case-backend，不走 HTTP 组图。
