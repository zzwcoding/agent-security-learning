# RESOURCES:信源清单(讲解论断挂这里,不凭记忆)

## 知识(官方文档 / 源码)

- **参考项目(只读,勿改)**:`/Users/divh/Downloads/深入理解agent 实验/ai-agent-book/chapter9/harness-safety-gate/`
  - `README.md` — 实验 9-7 全貌:三类反馈 → 确认门禁提案 → 模型外门槛 → 灰度;与 9-6 分工
  - `stable/tool_dispatcher.py` — 稳定版 v1.0.0:内存模拟 env + 6 工具,dispatch 无风险分级(缺陷本体)
  - `evolution.py` — 编排:诊断聚簇→候选打包→AST 静态闸→内存回放→发布决定+manifest
  - `llm_generator.py` — 真实 Coding Agent 路径(OpenAI 兼容 ark/openrouter/openai),回执含请求/响应哈希与用量
  - `run_experiment_9_7.py` — 验收入口:反例先行→确定性+真 LLM 同门槛→SHA 快照→11 条验收 gate
  - `demo.py` — 单提案离线教学入口
  - `boundary_cases.json` 8 条(必须拦)/ `retention_cases.json` 7 条(不许误伤)/ `failure_trajectories.json` 11 条(三类信号+对照轨迹)
  - `safety_policy_gate.py` — 上游同目录的独立加固版门禁(438 行):路径穿越/危险命令/资源限制/带 TTL 的一次性 token/回滚快照;与进化管线**互不引用**,配 27 项单测
  - `validation/real_20260807T160109Z/` — 官方真实运行证据:gpt-4o-mini 提案被门槛拒绝(预期安全结果),确定性提案过
- **姊妹复刻(结构参照)**:`/Users/divh/Downloads/安全评估agent/自修改agent复刻/`(实验 9-6,12 阶段;差异:9-7 无 Docker 沙箱,提案是新增模块非覆盖补丁)
- **主线对照(收官必读)**:`.scratch/agent-security-learning/issues/11-route3-execution/lessons/0034-串联闸-D4规则与LLM法官.md`;任务票见主线 commit c062741(阶段 42)

## 智慧(社区 / 实践者)

- 本仓库主线学习记录:`.scratch/agent-security-learning/issues/11-route3-execution/learning-records/`(阶段 39/42 的闸与票)
- 路线 1 同风格复刻项目:`攻防矩阵复刻/`、`执行工具复刻/`、`日志脱敏复刻/`(根目录惯例参照)

## 环境现实(已核实勿重复调研)

- LLM(阶段 11 用):MiniMax OpenAI 兼容端点,真 key 只走 Keychain(`agent-key minimax`),不进 git;离线优先,`--quick` 与 pytest 零 API Key
- Python 标准库即可跑通阶段 1-10;阶段 11 才需 `openai` 包
- 参照项目当前在 `replica` 分支(初始 commit 即含 safety_policy_gate.py,是上游原版非本机改动)
