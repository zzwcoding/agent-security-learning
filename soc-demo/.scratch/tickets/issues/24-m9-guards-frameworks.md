# 24: m9 guards 对齐 llm-guard + Presidio——手写引擎换点名框架（回补票）

**What to build:** services/guards 的手写 6 攻击族注入规则引擎与手写 5 识别器 PII 脱敏，替换为 llm-guard + Presidio 真依赖。**REST 契约不变**：/scan/injection、/pii/anonymize 的请求响应字段（含 scanner:"PromptInjection" 等）原样；fixtures/attack/injection 四布景期望判定不变；agent 侧 guards-client.ts 与其契约测试零改动。

**Blocked by:** （回补票）

**Touches modules:** `m9`

**Belongs to spec:** specs/modules.md

**Status:** done

### 出入记录（本票发现，记票不改 spec，交 L0 对账）

1. **FR-S4.2「脱敏映射表（mapstore）」在实现里自票 04 起就不存在**：architecture-guards-internal 投影图画了「脱敏映射表 · 服务端内存 · run 结束即弃」组件，但票 04 手写引擎与本票 Presidio 引擎都是无状态直接 `<TYPE>` 替换（契约返回 entities 偏移即可，无 re-identification 映射需求）。不改 spec 本体；投影文档保留该组件未删（属 FR-S4.2 承诺位），待 L0 裁决是补实现还是改投影。
2. **deberta 实测对 syslog 形态日志硬误报**：`Sep 8 … Accepted password for deploy` 被 protectai/deberta-v3-base-prompt-injection-v2 判 INJECTION score=1.0（朴素中英文句子干净）——实证佐证主判定路径用确定性启发式扫描器、模型只做本地可选层的裁决口径。
3. **torch 是 llm-guard 0.3.16 的硬依赖（包进 CI，模型不进）**：pip 解析会连带 torch 2.14 + NVIDIA CUDA 系列 wheel（Linux 上 GB 级下载），CI 时长增加但不违裁决（裁决禁的是 500MB deberta 模型下载）。镜像体积同因增大，Dockerfile 已修 COPY 隐患未做体积优化。

- [x] requirements.txt 真依赖 llm-guard + presidio-analyzer（lockfile 在场），扫描/识别主路径真的调用它们（源：PRD §4.1 C4·ADR 0002）
- [x] 注入扫描经 llm-guard 实现：6 攻击族（instruction_override/authority_escalation/tool_call_injection/data_exfiltration/prompt_exfiltration/invisible_chars）判定能力等价，四布景 fixtures/attack/injection 期望不变；llm-guard 扫描器族与手写族的映射表写进 lessons（源：票 04 契约保持·FR-S3.2/D2）
- [x] PII 经 Presidio 实现：EMAIL/PHONE/CN 手机号/CN 身份证/信用卡/IP 五识别器（中文识别器用自定义 PatternRecognizer），RFC1918 内网豁免语义保持（源：FR-S4.1·决策 #8·票 04 契约保持）
- [x] CI 离线口径：llm-guard 用启发式扫描器（不拉大模型）；Presidio + spacy en_core_web_sm（~12MB）允许 CI 安装；deberta 等大模型本地可选、CI 能力探测 skip 并打印原因（票 16 msbProbe 先例）——该口径由 ADR 0002 框架红线裁决背书，不许静默加回手写引擎（源：ADR 0002·框架红线）
- [x] agent 侧 guards-client 契约测试与超时 fail-closed 语义零改动全绿（源：票 04 接缝）
- [x] guards 全量测试迁移后全绿；架构投影文档（architecture-guards-internal.*）同步（源：票 04 回归·收尾第⑤样）
