# NOTES: 教学偏好速记

(沿用 issues/01 已确认的偏好;本任务新增的记这里)

- 讲解正文落盘 `lessons/NNNN-阶段名.md`,对话里只发 3–5 行摘要 + 路径
- 服务/API key 走 `agent-key` 从 Keychain 取,启动脚本注入,不硬编码
- 攻击证据要留可复核的痕迹:每次中招截图式日志贴进当阶段 learning-record
- 本地服务起前先 `lsof -nP -i:<端口>` 查占用;杀后台 job 时确认杀的是 python 进程本身,不是壳 job(阶段 10 留过孤儿)
- 阶段路线有调整时,先把 MISSION.md 里的路线表改好再动手,不要边做边改计划
- 精读类任务不派子 agent,主 agent 亲自做,且必须对照本项目实践(不是泛泛读书笔记)
