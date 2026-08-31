# RESOURCES:信源清单(讲解论断挂这里,不凭记忆)

## 知识(官方文档 / 源码)

- **参考项目(只读,勿改)**:`/Users/divh/Downloads/深入理解agent 实验/ai-agent-book/chapter9/self-modifying-agent/`
  - `README.md` — 实验 9-6 全貌:失败轨迹 → 自我修改 → 沙箱验证 → 灰度发布
  - `evolution.py` — 编排:聚合→诊断→确定性提案→静态闸→沙箱→发布决定+manifest
  - `candidate_sandbox.py` — 宿主侧 Docker 驱动(内容寻址镜像、JSON 协议、fail closed)
  - `sandbox_runner.py` — 容器入口(**宿主进程禁止 import**),跑 7 项语义检查
  - `llm_generator.py` — 真实 LLM 提案(OpenAI 兼容),只写 validation/<run>/candidates/
  - `run_experiment_9_6.py` — 验收入口(负对照+确定性+真 LLM 同门槛)
  - `Dockerfile.sandbox` — 沙箱镜像:禁网/IPC、只读 fs、非 root、全降 cap、禁提权
- **microsandbox SDK(阶段 12 对照用)**:`/Users/divh/Downloads/安全评估agent/.scratch/agent-security-learning/starter-agent/.venv/lib/python3.12/site-packages/microsandbox/_microsandbox.pyi` + `types.py`(权威 API 看这里,SDK 0.6.16)
- **主线阶段 24 边界对比**(对照复盘的上游结论):`.scratch/agent-security-learning/issues/09-route2-execution/lessons/0021-*.md`;逃逸探针 `.../09-route2-execution/escape-probe/probe.sh`
- **Docker Desktop**(本机可用):构建沙箱镜像需拉 python:3.12-alpine 基础镜像

## 智慧(社区 / 实践者)

- 本仓库主线学习记录:`.scratch/agent-security-learning/issues/09-route2-execution/learning-records/`(阶段 21-24 microVM 实测)
- 路线 1 同风格复刻项目:`攻防矩阵复刻/`、`执行工具复刻/`(结构对照)

## 环境现实(HANDOFF §3,已核实勿重复调研)

- LLM:MiniMax OpenAI 兼容端点 `https://api.minimaxi.com/v1`,model `MiniMax-M2`;
  真 key 只走 Keychain(`agent-key minimax`),`.env` 永远假密钥,真 key 不进 git
- macOS + arm64:参考项目 Docker 形态在 linuxkit VM 里跑,正常
