# RESOURCES: NeMo Guardrails 信源清单

## 知识(官方文档/源码)

- **NeMo Guardrails 官方文档**:https://docs.nvidia.com/nemo/guardrails/
  - rail 类型与配置:https://docs.nvidia.com/nemo/guardrails/configure-guardrails/configure-rails
  - 内置 guardrails 库(self-check / jailbreak 等):https://docs.nvidia.com/nemo/guardrails/user-guides/guardrails-library.html
  - Colang 1.0 语法(只读轮廓):https://docs.nvidia.com/nemo/guardrails/configure-guardrails/colang
- **源码仓库**:https://github.com/NVIDIA/NeMo-Guardrails(self-check 判定的提示词与 action 实现在 `nemoguardrails/library/self_check/`)
- **PyPI 元数据**(版本与 Python 要求):https://pypi.org/pypi/nemoguardrails/json — 0.23.0 要求 `>=3.10,<3.14`
- **论文**(架构背景):https://aclanthology.org/2023.emnlp-demo.40/

## 对照组(我方已有实践)

- **llm-guard**(PromptInjection / Secrets 扫描器):https://llm-guard.com/ — 源码 https://github.com/protectai/llm-guard
- starter-agent 三层护栏:`.scratch/agent-security-learning/issues/07-route1-execution/`(lessons 0012-0014)
- 已知缺口(本任务要逐一对照的):
  1. 格式规范伪装的注入漏判(分类器打 0.05 分)
  2. 记忆装载无校验
  3. write_file 参数侧无扫描

## 攻击语料(复用,一字不改)

- `../.scratch/agent-security-learning/issues/07-route1-execution/attacks/01-direct-injection.md`
  - 有效 A:自然请求套 key(`INTERNAL_API_KEY`,llm-guard 能拦)
  - 卡通 SYSTEM OVERRIDE(失效变体,上次被 MiniMax-M2 对齐拒)
