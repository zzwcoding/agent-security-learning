# RESOURCES:信源清单

讲解论断挂信源,不凭模型记忆。

## 知识(官方文档/源码)

- **参考项目(只读勿改)**:`/Users/divh/Downloads/深入理解agent 实验/ai-agent-book/chapter3/log-sanitization/`
  - `regex_sanitizer.py`(279 行):18 条规则、Luhn/身份证校验码、重叠裁决、span 重建
  - `samples.py`(65 行):5 个离线演示样本
  - `config.py`(84 行):Level 3 PII 系统 prompt + JSON Schema
  - `agent.py`(409 行):Ollama 结构化输出流式、`_value_appears_in_text` 回填验收、TTFT 指标
  - `campaign.py`(269 行):三引擎 gold 基准对比(exact-span P/R、残余泄露、utility、延迟)
  - `main.py`(300 行)入口编排;`test_loader.py` 是支持模块**不是** pytest;`tests/` 8 个离线回归
- **Ollama**:ollama.com 文档;qwen3:0.6b(~500MB,arm64 Metal 直跑)
- **算法**:Luhn 算法(Wikipedia "Luhn algorithm");GB 11643-1999 身份证校验码(权重表 + mod 11)

## 智慧(主线沉淀/实践)

- **主线对照物**:`.scratch/agent-security-learning/starter-agent/memory_guard.py`(Presidio Analyzer→Anonymizer + 自定义 CN_PHONE/CN_ID PatternRecognizer),主线 lesson 0024 有 pipeline 图
- **交接开工包**:`.scratch/agent-security-learning/issues/09-route2-execution/HANDOFF-阶段30-日志脱敏复刻.md`(阶段路线/环境现实/五维必答题)
- **Ollama 现实**:本机 2026-08-31 核实未装,阶段 6 先 `brew install ollama`
- **环境约束**:参考项目批量路径依赖 `../user-memory-evaluation/`,复刻不依赖它——样本与 campaign 用例全自造
