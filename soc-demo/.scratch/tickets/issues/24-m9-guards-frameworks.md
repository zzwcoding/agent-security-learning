# 24: m9 guards 对齐 llm-guard + Presidio——手写引擎换点名框架（回补票）

**What to build:** services/guards 的手写 6 攻击族注入规则引擎与手写 5 识别器 PII 脱敏，替换为 llm-guard + Presidio 真依赖。**REST 契约不变**：/scan/injection、/pii/anonymize 的请求响应字段（含 scanner:"PromptInjection" 等）原样；fixtures/attack/injection 四布景期望判定不变；agent 侧 guards-client.ts 与其契约测试零改动。

**Blocked by:** （回补票）

**Touches modules:** `m9`

**Belongs to spec:** specs/modules.md

**Status:** ready-for-agent

- [ ] requirements.txt 真依赖 llm-guard + presidio-analyzer（lockfile 在场），扫描/识别主路径真的调用它们（源：PRD §4.1 C4·ADR 0002）
- [ ] 注入扫描经 llm-guard 实现：6 攻击族（instruction_override/authority_escalation/tool_call_injection/data_exfiltration/prompt_exfiltration/invisible_chars）判定能力等价，四布景 fixtures/attack/injection 期望不变；llm-guard 扫描器族与手写族的映射表写进 lessons（源：票 04 契约保持·FR-S3.2/D2）
- [ ] PII 经 Presidio 实现：EMAIL/PHONE/CN 手机号/CN 身份证/信用卡/IP 五识别器（中文识别器用自定义 PatternRecognizer），RFC1918 内网豁免语义保持（源：FR-S4.1·决策 #8·票 04 契约保持）
- [ ] CI 离线口径：llm-guard 用启发式扫描器（不拉大模型）；Presidio + spacy en_core_web_sm（~12MB）允许 CI 安装；deberta 等大模型本地可选、CI 能力探测 skip 并打印原因（票 16 msbProbe 先例）——该口径由 ADR 0002 框架红线裁决背书，不许静默加回手写引擎（源：ADR 0002·框架红线）
- [ ] agent 侧 guards-client 契约测试与超时 fail-closed 语义零改动全绿（源：票 04 接缝）
- [ ] guards 全量测试迁移后全绿；架构投影文档（architecture-guards-internal.*）同步（源：票 04 回归·收尾第⑤样）
