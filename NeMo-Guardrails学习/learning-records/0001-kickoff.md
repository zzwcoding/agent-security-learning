# 0001: kickoff(2026-08-28)

**学了什么**:还没开始学,本记录是开工对齐。

**背景**:issues/07 阶段 18,平行窗口任务(交接说明 `issues/07-route1-execution/handoff-nemo-rails.md`)。不是复刻项目,是"精读 + 最小实践"。

**关键决策与依据**:
- 目录定为 `NeMo-Guardrails学习/`,与 `攻防矩阵复刻/`、`执行工具复刻/` 平行——沿用既有学习项目的布局
- Python 必须 3.12:PyPI 元数据显示 nemoguardrails 0.23.0 `requires_python >=3.10,<3.14`,系统 Python 3.14.6 装不上。`uv venv --python 3.12` 让 uv 自动拉
- 最小实践排除 payload B(touch PWNED):它依赖 run_command 工具,而最小壳无工具,测 rail 对**意图**的判定即可;execution rail 靠阶段 4 精读覆盖
- 测试 payload 锁定语料 01 的两条:有效 A(自然请求套 key)+ 卡通 SYSTEM OVERRIDE(失效变体)
- NeMo 有遥测,启动脚本里关:`NEMO_GUARDRAILS_NO_USAGE_STATS=1`

**卡在哪**:暂无。

**结论**:路线 6 阶段(见 MISSION.md 表)已与用户确认,下一步阶段 1 裸跑基线。
