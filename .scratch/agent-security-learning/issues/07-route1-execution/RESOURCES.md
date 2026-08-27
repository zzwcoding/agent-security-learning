# RESOURCES: 路线 1 信源清单

## 知识(官方文档/源码)

- **llm-guard**(扫描器:PromptInjection / Secrets):https://llm-guard.com/ — 源码 https://github.com/protectai/llm-guard
- **NeMo Guardrails 五种 rail**(input/output/dialog/retrieval/execution):https://docs.nvidia.com/nemo/guardrails/
- **codex `sandbox_mode` 三档**(read-only / workspace-write / danger-full-access):https://github.com/openai/codex 源码 + docs/sandbox.md
- **Langfuse 自托管**:https://langfuse.com/self-hosting — docker compose 本地起服务;Python SDK trace 接入 https://langfuse.com/docs
- **Docker 加固参数**(--read-only / --tmpfs / --cap-drop / --memory / --cpus / 非 root USER):https://docs.docker.com/engine/containers/run/

## 智慧(练兵场实验,本地路径)

- `../../../深入理解agent 实验/ai-agent-book/chapter2/prompt-injection` — 攻防矩阵,三类注入 payload 参考
- `../../../深入理解agent 实验/ai-agent-book/chapter4/execution-tools` — 分层安全架构
- 练兵场总图:`../../../深入理解agent 实验/ai-agent-book/.local/security-scan/SECURITY-EXPERIMENTS.md`

## 本任务素材(自建)

- `attacks/` — payload 语料(三类注入,防御回归复用同批)
- 战利品:`starter-agent/workspace/.env`(假密钥,含 `INTERNAL_API_KEY`)
