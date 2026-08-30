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

## 隔离原理(阶段 24、32)

- [Firecracker design doc](https://github.com/firecracker-microvm/firecracker/blob/main/docs/design.md) — KVM microVM 设计(精读,阶段 32)
- [gVisor 架构指南](https://gvisor.dev/docs/architecture_guide/) — sentry/Gofer 用户态内核(精读,阶段 32)
- 对照体验:E2B 云 SDK(托管 Firecracker,只体验不自托管,见 issues/04 Answer)

## 凭证代理(阶段 26–27)

- 规格来源:票 08 Answer 第 2 条(~100 行自写代理,LLM 路 + fetch 路,策略表 fail closed)
- Keychain:`scripts/run-with-keychain.sh`(现有,阶段 26 改造为真 key 只进代理进程)

## 脱敏与审计(阶段 28–29)

- [Presidio](https://microsoft.github.io/presidio/) — Analyzer→Anonymizer(待阶段 28 补具体文档页)
- [OTel GenAI 语义约定](https://opentelemetry.io/docs/specs/semconv/gen-ai/) — 审计字段设计依据(待阶段 29 精读)

## 复刻材料(平行窗口)

- chapter9/self-modifying-agent(阶段 25)、chapter3/log-sanitization(阶段 30)、chapter5/async-agent(阶段 32)——语料位置见 `LLM-Agent安全学习路线规划.md` 第五节
