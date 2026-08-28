# 交接说明:新窗口复刻实验 4-4(执行工具分层安全架构)

> 用法:把下面分割线之间的内容整段贴进新窗口。

---

使用 learn-by-rebuild 这个 skill,带我从零复刻一个参考实验:带 LLM 事前审批的执行工具服务器(Experiment 4-4,分层安全架构)。

## 参考项目(精读对象,只读不改)

`/Users/divh/Downloads/深入理解agent 实验/ai-agent-book/chapter4/execution-tools/`
- `README.md`(488 行):功能清单、四层架构(安全层/工具层/校验层/集成层)、CLI 用法、离线 demo 路径;开头有官方 Code map
- `execution_tools.py`(280 行):核心——危险模式匹配 + 二级 LLM 事前审批的两段式拦截(代码审批 114-138 行、shell 审批 208-227 行)
- `llm_helper.py`(346 行):二级 LLM 助手(审批 request_approval、长输出总结、错误/语法分析)
- `terminal_controller.py`(504 行)/ `file_tools.py`(210 行):工具层实现
- `cli.py`(410 行):统一 CLI,`python cli.py demo` 是离线端到端入口(无需 API key)
- `server.py`(363 行):MCP server 封装
- 长输出截断与持久化:超阈值(默认 200 行/10000 字符)只留头尾各 50 行进上下文,全文落盘临时文件并返回路径

## 复刻的核心形态(裁剪后)

一个"执行工具"集合(file_write / file_edit / code_interpreter / virtual_terminal),每个工具调用经过:
① **危险模式匹配**(确定性规则先筛)→ ② **二级 LLM 事前审批**(可疑的交给独立 LLM 裁决)→ ③ **执行** → ④ **自动校验**(语法检查等可验证项)→ ⑤ **长输出截断+持久化**。
 workspace 边界:文件操作限制在指定目录内。

**明确跳过**(参考项目里有但第一遍不复刻):Google Calendar / GitHub PR 集成、桌面(Xvfb)与安卓(AndroidWorld)探针、多语言执行器、MCP transport 可后置为最后一个阶段或简化。

## 环境约定(macOS)

- 复刻目标目录:开工前先和我确认(上一个复刻项目在 `安全评估agent/攻防矩阵复刻/`,本次建议平行新目录)
- 依赖:`uv venv .venv` + `uv pip install --python .venv/bin/python <pkg>`
- LLM key 用 `agent-key <供应商>` 从 Keychain 取,启动脚本注入,不硬编码;供应商 MiniMax-M2
- 注意:本实验的 LLM 有两种角色——干活的和审批的(二级 LLM);复刻时两者可以用同一个模型,但要是两次独立调用

## 教学要求

- 每阶段小步可运行、讲解落盘 lessons/、节奏听我的("下一步"推进,"提交"才 commit)
- 关键概念要讲透:为什么审批要用**独立** LLM 而不是主模型自问自答;"模式匹配先筛 + LLM 裁决可疑"的两段式各自防什么;长输出为什么留头尾而不是只留头;这套"LLM 审批"与攻防矩阵实验里 D4 的"目标须在本轮用户消息"规则式校验各是什么取舍(模型式 vs 规则式执行闸)
- 复刻完成后,与 `安全评估agent/.scratch/agent-security-learning/starter-agent/` 的裸奔 run_command / write_file 做一次对照:如果把这套审批闸挂回 starter-agent,路线 1 的哪些缺口能被补上

---
