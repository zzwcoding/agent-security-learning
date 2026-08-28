# 交接说明:新窗口做 NeMo Guardrails 五种 rail 精读 + 最小实践

> 用法:把下面分割线之间的内容整段贴进新窗口。

---

带我完成一个"精读 + 最小实践"任务:NeMo Guardrails 五种 rail。用 learn-by-rebuild 的教学纪律(小步可运行、讲解落盘 lessons/、我说"下一步"才推进、说"提交"才 commit),但这个任务不是复刻项目,是读文档 + 搭一个最小验证。

## 任务背景(我在另一个项目里已有的底子)

我在 `安全评估agent` 项目里给一个 LangGraph Agent(starter-agent)挂过三层护栏:llm-guard 的 PromptInjection 扫描器扫用户输入和工具返回(分块)、Sensitive 扫输出。已确认的缺口:格式规范伪装的注入会漏判(分类器打 0.05 分)、记忆装载无校验、write_file 参数侧无扫描。本次学习要回答:NeMo 的五种 rail 对照这些缺口能补什么。

## 精读对象(信源,论断挂 URL)

- 官方文档:https://docs.nvidia.com/nemo/guardrails/ (重点:rail 类型、配置方式、运行时序)
- 源码仓库:https://github.com/NVIDIA/NeMo-Guardrails

## 要学到的(精读产出)

五种 rail(输入 input / 对话 dialog / 检索 retrieval / 执行 execution / 输出 output)逐个讲清:触发点在 LLM 调用链哪个位置、典型用途、怎么配置。重点讲透:rail 的判定机制(LLM 自检提示词 vs 纯 Python 规则)与我们 llm-guard deberta 分类器的取舍;一条用户消息进来五种 rail 的完整时序。Colang DSL 只读轮廓(知道它干什么、为什么不深入),不学具体编排。

## 最小实践(动手部分)

1. `uv venv` 起环境装 nemoguardrails,跑通官方 quickstart 的最小 guardrail(纯 YAML 的 self-check input/output rail,不碰 Colang)
2. 拿我上一个项目的攻击语料打它,和 llm-guard 对照。语料在 `/Users/divh/Downloads/安全评估agent/.scratch/agent-security-learning/issues/07-route1-execution/attacks/01-direct-injection.md`(重点打两条:"卡通 SYSTEM OVERRIDE"和"自然请求套 key"——前者 llm-guard 能拦,后者也能;我想知道 NeMo 的 LLM 自检 rail 表现如何,以及一次请求的延迟/token 代价)
3. 记录:哪些 payload 被拦、误报如何、每次 rail 判定多花了多少 LLM 调用

## 环境约定(macOS)

- 目标目录:开工前先和我确认(建议与 `安全评估agent/攻防矩阵复刻/` 平行的新目录)
- 依赖:`uv venv .venv` + `uv pip install --python .venv/bin/python nemoguardrails`
- LLM key 用 `agent-key minimax` 从 Keychain 取,环境变量注入(LLM_BASE_URL=https://api.minimaxi.com/v1,LLM_MODEL=MiniMax-M2),不硬编码

## 产出

- lessons/ 下每阶段教学 md(五种 rail 各一篇或合并,按节奏切)
- 一份对照结论:五种 rail vs 我们的三层护栏 + 缺口清单,逐个对上"能补/不能补/为什么"
- 最小实践的实测记录(payload × rail 结果表)

---
