# HANDOFF:阶段 25 — chapter9/self-modifying-agent 对照复刻(平行窗口开工包,2026-08-31)

> 给新窗口的复刻专用交接。主线窗口(路线 2 阶段 26 凭证代理)与本窗口并行,互不阻塞。

## 0. 位置感

- 这是路线 2(票 09)的阶段 25:chapter9/self-modifying-agent **对照复刻**,教学纪律全文见 `learn-by-rebuild` skill(用户级已装,先读它)
- 复刻主题与路线 2 主线的关系:参考项目用**加固一次性 Docker 容器**验证不可信的候选代码——这正是主线阶段 21-24 用 microsandbox microVM 替换掉的形态。复刻做到最后要把这个对照做实(见 §4 必答题)
- **参考项目(只读,勿改)**:`/Users/divh/Downloads/深入理解agent 实验/ai-agent-book/chapter9/self-modifying-agent/`
- **本项目落点(用户指定)**:仓库根目录 `/Users/divh/Downloads/安全评估agent/自修改agent复刻/`(与路线 1 的 `攻防矩阵复刻/`、`执行工具复刻/` 同风格)

## 1. 参考项目架构速览(共 1357 行,开工先按此顺序读)

1. `README.md` — 实验 9-6 全貌:失败轨迹 → 自我修改 → 沙箱验证 → 灰度发布
2. `stable/retry_policy.py`(16 行)— 被修改的稳定版,故意带 bug:`should_retry` 无视 `retryable` 标志、熔断无视错误类型
3. `failure_trajectories.json` — 生产失败轨迹(同一个 `retryable=false` 错误被反复重试)
4. `evolution.py`(322 行)— 编排:聚合轨迹 → 诊断 → 确定性提案(源码里内置 OLD_*/NEW_* 最小 diff)→ 宿主静态闸(compile+AST 拒绝列表)→ 调沙箱 → 发布决定 + manifest + SHA-256
5. `candidate_sandbox.py`(205 行)— 宿主侧 Docker 驱动:内容寻址沙箱镜像、JSON 协议、大小限幅、超时/OOM/docker 缺失一律 fail closed
6. `sandbox_runner.py`(161 行)— **容器入口(宿主进程禁止 import)**:exec 候选源码,跑 7 项语义检查(签名兼容/失败重放/永久错误熔断/临时恢复/旧任务回归/canary/回滚)
7. `llm_generator.py`(133 行)— 真实 LLM 提案(OpenAI 兼容端点),只写 `validation/<run>/candidates/`
8. `run_experiment_9_6.py`(247 行)— 验收入口:负对照(坏提案必拒)+ 确定性 + 真实 LLM 走同一组门槛;`evidence.json` 存原始请求响应
9. `Dockerfile.sandbox` — 沙箱镜像定义(禁网/IPC、只读 fs、非 root、全降 cap、禁提权)

核心思想一句话:**LLM 只产"提案",编译、执行、验证、发布决定、回滚全部由模型外的确定性代码完成;稳定代码/审计日志/验证器是可信根,不进自我修改权限。**

## 2. 阶段路线(12 阶段,每阶段 ≤30 行新增、可运行、有可观察变化)

| # | 新增什么 | 可观察变化 | 学到什么 |
|---|---|---|---|
| 1 | 骨架 + `stable/retry_policy.py`(带 bug)+ `failure_trajectories.json` + 轨迹读取打印 | 脚本输出"同一 retryable=false 错误被重试 3 次" | 为什么修代码而不是往 prompt 里加一句"别重试" |
| 2 | 轨迹聚合 → 修改请求(同一模式 ≥2 条轨迹支持才成案) | 打印"修改请求:根因=stable/retry_policy.py" | 多轨迹支持才动手,防误改 |
| 3 | 确定性提案:最小 diff 写 `output/candidate/`,绝不覆盖 stable | 打印 diff(candidate vs stable) | 候选与稳定物理隔离 |
| 4 | 宿主静态闸:py_compile + AST 拒绝列表(import os/socket、eval/exec、open…) | 打印静态检查逐项结果 | AST 预筛是纵深防御,不是执行不可信代码的安全边界 |
| 5 | 沙箱:加固 Docker 容器跑候选(内容寻址镜像 + JSON 协议 + 限幅 + fail closed),形态照抄参考项目 Dockerfile.sandbox | 容器内检查结果 JSON 回传打印 | 不可信代码的执行面;协议化校验 |
| 6 | 容器内语义检查(上):public_api_compatible + failure_replay + nonretryable_circuit | 逐项 ✓/✗ | 验证的是"行为",不是"代码像不像" |
| 7 | 容器内语义检查(下):temporary_recovery + old_task_regression + canary_ready + rollback_ready | 逐项 ✓/✗ | 回归检查=新补丁不许破坏旧行为 |
| 8 | 发布决定 + manifest:release_to_canary / reject_candidate + 清单(哈希/diff/全检查) | 打印决定 + release_manifest.json | 发布决定在模型外 |
| 9 | 可信根自证:stable/验证器/轨迹输入的 SHA-256 前后对比 | 打印哈希对比(不变) | 可信根在自我修改权限之外 |
| 10 | LLM 提案生成器(OpenAI 兼容 → MiniMax,Keychain 注入,`.env` 假密钥),只写 `validation/<run>/candidates/` | 真实 LLM diff 打印 | LLM 输出只是提案,准入靠模型外门槛 |
| 11 | 验收入口:负对照(禁用全部重试的坏提案)必拒 + 确定性 + 真实 LLM 同门槛对比 + evidence.json | 三方检查表对比打印 | 同一组闸对确定性/LLM 一视同仁 |
| 12 | **对照收官(路线 2 特色)**:候选验证沙箱后端对照——加固 Docker vs microsandbox 一次性 microVM,同一候选同一组检查;`escape-probe/probe.sh`(主线阶段 24 产物)在两个验证沙箱各跑一遍;结论写复盘 | 对照表 + 复盘结论 | 执行面选型:回答 §4 必答题 |

节奏纪律(learn-by-rebuild):用户说"下一步"才推进;说"提交"才 commit(前缀建议 `复刻 N:`,与主线 `阶段 N:` 区分)。

## 3. 环境现实(本机已核实,勿重复调研)

- **Docker Desktop 可用**(本会话已启动;`starter-agent:latest` 镜像在;构建沙箱镜像需拉 python:3.12-alpine 基础镜像,参考项目 Dockerfile.sandbox 会自动内容寻址构建)
- **microsandbox 已装**:`starter-agent/.venv`(SDK 0.6.16,嵌入式拉 VM 无守护进程)。已核实:VM 冷启动 ~0.5s、宿主零可见、网关默认拒私网(公网开)、`Sandbox.create(ephemeral=True)` 一次性。权威 API 看 `.venv/lib/python3.12/site-packages/microsandbox/_microsandbox.pyi` 与 `types.py`
- **LLM**:MiniMax OpenAI 兼容端点(`https://api.minimaxi.com/v1`,model `MiniMax-M2`);真 key 只走 Keychain(`agent-key minimax`,参考 `starter-agent/scripts/run-with-keychain.sh`);`.env` 永远假密钥;真 key 不进 git
- **macOS + arm64**:参考项目 docker 形态在 linuxkit VM 里跑,正常

## 4. 对照复盘必答题(阶段 12 的落点,写进复盘 md)

**候选代码的验证沙箱,选加固 Docker 还是一次性 microVM?** 至少从四个维度对比后给结论,不许和稀泥:
1. 隔离级别:共享 linuxkit 内核 vs 独立内核(阶段 24 实测过)
2. 网络边界:`--network none` vs 网关默认拒私网
3. 工程成本:Docker daemon 依赖/镜像管理 vs SDK 嵌入式拉起(冷启动 ~0.5s)
4. 失败语义:超时/OOM/协议异常的 fail closed 两边怎么等价实现

## 5. 归档与编号约定

- 项目内自建 `MISSION.md` / `RESOURCES.md` / `lessons/` / `learning-records/`(learn-by-rebuild 纪律);**编号从 0001 起在自己的目录内**,与主线 `issues/09-route2-execution/lessons/`(已用到 0021)互不干扰
- 收官动作:项目内收官 commit(`复刻收官:`前缀)+ 顺手把 `issues/09-route2-execution/MISSION.md` 阶段 25 行勾掉(⚠ 只 add 自己的文件和 MISSION 这一行,主线窗口可能有未提交改动);已知遗留:`lessons/0019-tool&mcp.md` 与主线 0019 编号撞车,待用户处置,复刻窗口不要动它
- 复盘结论同步一份到主线:`deliverables/route2/` 边界对比报告(阶段 33 收官时)可引用本复刻的对照表

## 6. 复制即用开场白

```
读 /Users/divh/Downloads/安全评估agent/.scratch/agent-security-learning/issues/09-route2-execution/HANDOFF-阶段25-自修改agent复刻.md,
按 learn-by-rebuild 的纪律在仓库根目录做 chapter9/self-modifying-agent 的对照复刻(项目放 自修改agent复刻/),从阶段 1 开始。
```
