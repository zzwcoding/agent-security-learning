# MISSION:chapter9/self-modifying-agent 对照复刻(路线 2 阶段 25)

> **状态:✅ 12/12 阶段全部完成(2026-08-31)。** 收官必答已落盘:[对照复盘-验证沙箱选型.md](对照复盘-验证沙箱选型.md)——
> 结论:候选验证沙箱选一次性 microVM,加固 Docker 降为备选;16/16 验收 gate 全过,双后端灯表 100% 一致。

**一句话目标**:从零复刻"实验 9-6:由失败轨迹触发的 Agent 自我修改",搞懂它的安全骨架——
**LLM 只产"提案",编译、执行、验证、发布决定、回滚全部由模型外的确定性代码完成;
稳定代码 / 审计日志 / 验证器是可信根,不进自我修改权限。**

**为什么学**(区别于"做什么"):主线(票 09)阶段 21-24 已经用 microsandbox 一次性 microVM
替换掉了参考项目"加固一次性 Docker 容器"这个形态。这次反着来——把参考项目忠实复刻一遍,
才知道主线换掉了什么、保留了什么,阶段 12 把这个对照做实。

## 验收标准(12 阶段路线,来自 HANDOFF §2)

| # | 新增什么 | 可观察变化 |
|---|---|---|
| 1 | 骨架 + 带 bug 的 stable + 失败轨迹 + 读取打印 | 输出"同一 retryable=false 错误被重试 3 次" |
| 2 | 轨迹聚合 → 修改请求(≥2 条轨迹支持才成案) | 打印"修改请求:根因=stable/retry_policy.py" |
| 3 | 确定性提案:最小 diff 写 output/candidate/ | 打印 candidate vs stable 的 diff |
| 4 | 宿主静态闸:py_compile + AST 拒绝列表 | 打印静态检查逐项结果 |
| 5 | 沙箱:加固 Docker 容器跑候选(照抄 Dockerfile.sandbox 形态) | 容器内检查结果 JSON 回传 |
| 6 | 容器内语义检查(上):签名兼容/失败重放/永久错误熔断 | 逐项 ✓/✗ |
| 7 | 容器内语义检查(下):临时恢复/旧任务回归/canary/回滚 | 逐项 ✓/✗ |
| 8 | 发布决定 + release_manifest.json | 打印决定 + 清单 |
| 9 | 可信根自证:stable/验证器/轨迹输入 SHA-256 前后对比 | 打印哈希对比(不变) |
| 10 | LLM 提案生成器(MiniMax,Keychain 注入),只写 validation/<run>/candidates/ | 真实 LLM diff 打印 |
| 11 | 验收入口:负对照必拒 + 确定性 + 真 LLM 同门槛 + evidence.json | 三方检查表对比 |
| 12 | 对照收官:加固 Docker vs microsandbox microVM 同一候选同一组检查;probe.sh 两边各跑一遍 | 对照表 + 复盘结论 |

## 收官必答(阶段 12 写进复盘,不许和稀泥)

**候选代码的验证沙箱,选加固 Docker 还是一次性 microVM?** 四维度:
隔离级别 / 网络边界 / 工程成本 / 失败语义(fail closed 两边怎么等价实现)。

## 纪律(learn-by-rebuild + HANDOFF §5)

- 每阶段 ≤30 行新增、可运行、有可观察变化;用户说"下一步"才推进,"提交"才 commit
- commit 前缀 `复刻 N:`(与主线 `阶段 N:` 区分);编号从 0001 起在自己的目录内
- 参考项目只读勿改:`/Users/divh/Downloads/深入理解agent 实验/ai-agent-book/chapter9/self-modifying-agent/`
