# RESOURCES: 路线 2 信源清单

> 讲解论断挂信源,不凭模型记忆。知识=官方文档/源码;智慧=社区/实践者。

## microsandbox(阶段 21–24、27)

- [microsandbox/microsandbox README](https://github.com/superradcompany/microsandbox) — 跨平台支持、SDK 形态、MCP server
- [Python SDK:Sandbox API](https://docs.microsandbox.dev/sdk/python/sandbox) — create/exec/shell/Network/SecretEntry 全参数(本路线主参考)
- [CLI sandbox commands](https://docs.microsandbox.dev/cli/sandbox-commands) — `msb run` 行为:无名=临时,跑完即删
- [Secrets 文档](https://docs.microsandbox.dev/sandboxes/secrets) — per-domain secret 注入(阶段 27 对照阅读材料)
- [macOS 故障排查(要求 Apple Silicon)](https://docs.microsandbox.dev/troubleshooting/macos)
- 本地信源(装好后以它为准):`starter-agent/.venv/lib/python3.12/site-packages/microsandbox/_microsandbox.pyi` + `types.py` — Rust 原生扩展,存根即权威 API 定义
- 版本快照:CLI/SDK 均 0.6.16(2026-08-29 安装)
- beta 边界实测结论(以 lessons 为准):domain 白名单规则在 0.6.16 失效(`lessons/0020-fetch进microVM+出网白名单.md`);网关默认拒私网但公网默认开(`lessons/0021-边界对比-Docker-vs-microVM.md`,修正阶段 21 初判)

## 隔离原理(阶段 24、32)

- [Firecracker design doc](https://github.com/firecracker-microvm/firecracker/blob/main/docs/design.md) — KVM microVM 设计(精读,阶段 32)
- [gVisor 架构指南](https://gvisor.dev/docs/architecture_guide/) — sentry/Gofer 用户态内核(精读,阶段 32)
- 对照体验:E2B 云 SDK(托管 Firecracker,只体验不自托管,见 issues/04 Answer)

## 凭证代理(阶段 26–27,已落地)

- 规格来源:票 08 Answer 第 2 条(~100 行自写代理,LLM 路 + fetch 路,策略表 fail closed)
- 本地实现:LLM 路 `starter-agent/proxy.py`(Keychain 注入 Authorization,SSE 流式透传,lesson 0022);fetch 路 `mcp_servers/fetch_server.py` 的 `CREDENTIAL_POLICY` + `{{SECRET:}}` 占位符(lesson 0023)
- Keychain 启动脚本:`scripts/run-proxy.sh`(真 key 只进代理进程)+ `scripts/run-agent.sh`(Agent 零密钥裸启动);原 run-with-keychain.sh 已拆分退役

## 脱敏与审计(阶段 28–29,已落地)

- [Presidio Analyzer](https://microsoft.github.io/presidio/analyzer/) / [Anonymizer](https://microsoft.github.io/presidio/anonymizer/) / [自定义识别器](https://microsoft.github.io/presidio/analyzer/custom_recognizers/) — 本地实现 `starter-agent/memory_guard.py`(CN_PHONE/CN_ID PatternRecognizer,lesson 0024 含 pipeline 与 encrypt 两张数据流图)
- [OTel GenAI 语义约定](https://opentelemetry.io/docs/specs/semconv/gen-ai/) — 五要素审计字段(audit.who/when/why/params/data_class)落 Langfuse trace metadata;langfuse v4 读 API 不水合、OTLP 出网捕获验证的绕道实录在 `lessons/0025-OTel审计字段.md`

## 复刻材料(平行窗口)

- chapter9/self-modifying-agent(阶段 25)✅ 已收官:产物 `自修改agent复刻/`,收官对照 `自修改agent复刻/对照复盘-验证沙箱选型.md`(选一次性 microVM)
- chapter3/log-sanitization(阶段 30)✅ 已收官:产物 `日志脱敏复刻/`,收官拍板 `日志脱敏复刻/对照复盘-三引擎分工拍板.md`(三出口分工:memory.json=Presidio,trace/日志=regex 在线+hybrid 离线)
- chapter6/async-agent(阶段 32)✅ 已完成(lesson 0027 对照讨论;⚠ 参考项目在 chapter6 非 chapter5,原记录有误)
- chapter5/permission-embedded-data-objects:对照讨论时顺带核实——主题是数据层授权(实验 5-12),不是白名单;属路线 3 预习材料,路线 2 不用
