# NOTES: 教学偏好速记

(沿用 issues/01、issues/07 已确认的偏好;本任务新增的记这里)

- 讲解正文落盘 `lessons/NNNN-阶段名.md`,对话里只发 3–5 行摘要 + 路径
- LLM key 走 `agent-key minimax` 从 Keychain 取,启动脚本注入,不硬编码;顺手关 NeMo 遥测 `NEMO_GUARDRAILS_NO_USAGE_STATS=1`
- 攻击证据要留可复核的痕迹:每次 payload 实测的输入/输出/判定日志贴进当阶段 learning-record
- 阶段路线有调整时,先把 MISSION.md 里的路线表改好再动手,不要边做边改计划
- 精读类任务不派子 agent,主 agent 亲自做,且必须对照本项目实践(不是泛泛读书笔记)
- 最小实践不建 agent:无工具、无 LangGraph,薄壳 chat.py;payload B 因依赖 run_command 工具排除
