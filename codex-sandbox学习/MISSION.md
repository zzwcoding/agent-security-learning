# MISSION — Codex CLI 沙箱模式

## 学习目标（一句话）

吃透 Codex CLI 的权限模型：**沙箱（内核强制"能做什么"）× 审批策略（"想要更多时怎么办"）两个独立旋钮**，能独立为不同场景（日常 / CI / 陌生仓库）选出正确组合。

## 为什么学

- 这是终端 agent 品类里少有的 **OS 内核级强制**安全机制（macOS Seatbelt / Linux bubblewrap），不是提示词自律——学 Agent 安全绕不开它。
- 它是"被解释得最差的特性之一"：旗标改名、被删、默认值随目录漂移、全网把沙箱和审批混为一谈。学完能避开这些坑。

## 验收标准

学完后能不看资料回答：

1. sandbox mode 和 approval policy 各自管什么？组合矩阵里 `read-only + never` 会发生什么？
2. 三种 sandbox 模式的写盘 / 网络 / 进程权限分别是什么？`read-only` 为什么还能跑测试？
3. macOS / Linux / Windows 三平台的强制实现分别是什么？Windows 上 `workspace-write` 会发生什么？
4. 为什么脚本和 CI 里必须显式传 `--sandbox`？`codex exec` 为什么没有 `-a` 旗标？
5. `--full-auto` 和 `on-failure` 现在是什么状态？

## 阶段路线

| 阶段 | 主题 | 学到什么 |
|---|---|---|
| 1 | 两个旋钮：sandbox ≠ approval | 核心心智模型，全网最常见错误 |
| 2 | 三种 sandbox 模式 | read-only 能跑进程；workspace-write 保护 `.git` 等元数据目录 |
| 3 | 各 OS 的强制实现 | Seatbelt / bubblewrap+seccomp（Landlock 已 legacy）/ Windows 静默降级 |
| 4 | approval policy 与组合矩阵 | untrusted/on-request/never/granular；`on-failure` 已废；组合决定体感 |
| 5 | 默认值与 `codex exec` | 默认值随目录信任漂移；exec 无 `-a`；`--full-auto` 已删 |
| 6 | 四个实战配方与选型 | review / 断网写盘 / CI / `codex sandbox` 探测；落地清单 |

## 环境备注

- 本机当前**未安装 codex CLI**（`which codex` 为空），学习以概念 + 源码引用为主；
  第 6 阶段的 `codex sandbox` 实测需要 `npm i -g @openai/codex` 后才能做，到时再定。
