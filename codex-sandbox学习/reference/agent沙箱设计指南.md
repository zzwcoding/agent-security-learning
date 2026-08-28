# 给自己的 agent 设计沙箱 —— 从 Codex 案例提炼的实操指南

> 依据：本课程 lessons 0000–0003 拆解的 Codex 设计 + 你的平台（macOS）。
> 定位：reference 文档，持续维护；不是阶段稿。

## 0. 总原则（先背下来再设计）

1. **复用 OS 原语，不造沙箱机制**。自己发明隔离机制是危险信号；策略层才是你该写的。
2. **沙箱是地板，不是天花板**。OS 层强制兜底（模型绕不过），应用层检查做体验（报错信息友好）。两层都要，缺一不可。
3. **能力（sandbox）与交互（approval）分开设计**，两个旋钮独立演进。
4. **一切默认 fail-closed**：能力缺失 → 降级，绝不静默裸跑。

## 1. 权限模型设计（先于任何代码）

最小可用集抄 Codex 三档，但你**可以从两档起步**（砍掉 `danger-full-access`，它的正当用途只有"外层已有别的沙箱"）：

| 模式 | 写盘 | 网络 | 进程 |
|---|---|---|---|
| `read-only` | 全无 | 关 | 允许（探索、跑只读命令） |
| `workspace-write` | 可写根白名单 | 关（显式开） | 允许 |

决策清单：

- **可写根**：默认 = 工作目录 + 系统临时目录；提供配置追加。不要把"用户主目录"当默认值。
- **元数据保护**：可写根内把 `.git`（尤其 `hooks/`）、agent 自己的配置目录挖掉保持只读。追问模板："这个可写文件会被谁、何时、以什么权限再执行？"——能答上来的全保护。
- **网络是独立闸门**：默认关。能读文件 + 能联网 = 能外泄。开网做成显式开关，最好按域名白名单而不是全开。
- **危险工具单独标注**：`send_email`、`exec_shell` 这类副作用工具，除了沙箱还要走 approval 旋钮（参考你攻防矩阵 demo 里的高风险工具处理）。

## 2. 选底层原语（按平台，你当前是 macOS）

| 平台 | 原语 | 形态 | 注意 |
|---|---|---|---|
| macOS | Seatbelt（内核自带） | `sandbox-exec -f policy.sbpl <cmd>` | 苹果已标记 deprecated 但仍可用，Codex 0.146 仍在用；子进程继承策略 |
| Linux | bubblewrap | `bwrap --ro-bind / / --bind <根> <根> --unshare-net ... <cmd>` | 需用户命名空间（WSL1、加固容器不行→fail-closed） |
| 跨平台偷懒方案 | Docker 容器 | agent 的命令全在一次性容器里跑 | 重，但心智模型简单，CI 场景天然合适 |

**macOS 最小策略骨架**（真实策略要按 deny 日志补平台库路径，这只是结构示意）：

```lisp
;; policy.sbpl —— 白名单范式:开局全拒,逐项放行
(version 1)
(deny default)

;; 能跑进程(read-only 模式也保留这两条,"能跑不能写"就靠它)
(allow process-exec)
(allow process-fork)

;; 系统库/二进制的读(不写这些,ls 都启动不了;具体清单跑一遍看 deny 日志补)
(allow file-read* (subpath "/usr") (subpath "/bin") (subpath "/System") (subpath "/Library"))
(allow file-read* (subpath "/Users/you/proj"))          ;; 工作区可读

;; workspace-write 模式才加这段;read-only 删掉
(allow file-write* (subpath "/Users/you/proj") (subpath "/tmp") (subpath "/private/tmp"))
;; 元数据保护:即使上面放行了工作区,这里再拒掉 .git
(deny file-write* (subpath "/Users/you/proj/.git"))

;; 网络默认关:不显式 allow network*,(deny default) 自动接管
```

执行侧就一行：

```bash
sandbox-exec -f policy.sbpl <agent要跑的命令>
```

## 3. 接线：包在执行层，不是提示词层

```
模型 tool_call(shell, cmd)
   │
   ▼
应用层检查(体验层): 路径规范化、危险命令提示、approval 判定
   │  —— 这层可以被绕过,它的产出是"友好的错误",不是安全
   ▼
沙箱包装(地板层): sandbox-exec -f <当前模式策略> cmd
   │  —— 这层模型看不见也绕不过,越界=EPERM
   ▼
结果(含 EPERM 失败)回喂模型
```

要点：**所有**能碰 shell/文件的工具都走同一个包装入口，不留"某个工具忘了包"的旁路。攻击面 = 入口数量，入口收敛到 1 个才能审计。

## 4. approval 旋钮（独立设计）

- 三档起步：`untrusted`（凡事先问）/ `on-request`（出沙箱才问）/ `never`（硬拒，失败回喂模型）。
- **headless（脚本/CI 驱动）模式强制 `never`**——没人按的弹窗 = 挂死。失败变非零退出码才是自动化能处理的东西。
- 记住 Codex 的教训：`untrusted` 是让安全沙箱变吵，不是变更安全；想要"安静的安全"应该收紧沙箱 + `never`。

## 5. fail-closed 与可观测性（容易被砍、不能砍的部分）

- 沙箱后端不可用时（比如某天 `sandbox-exec` 真被苹果删了）：**降级到更严模式并大声警告**，不要静默无沙箱执行。
- 环境变量告知运行时：`AGENT_SANDBOX=seatbelt`、`AGENT_SANDBOX_NETWORK_DISABLED=1`，让被跑的测试/脚本能感知并跳过联网用例。
- 留一个探测入口：`your-agent sandbox -- <cmd>`，用真实策略跑任意命令，配合 macOS 的 `log stream` 看 deny 记录——没有自测手段的安全机制只是声明。
- 默认值不许是"历史决定"：模式必须显式可指定，CI 脚本里永远显式传（Codex 的"目录信任决定默认值"是交互友好、脚本灾难的反例）。

## 6. 落地路线（给你攻防矩阵 demo 的最小三步）

1. **先加包装入口**：把 `demo.py` 里执行工具的函数改成统一走 `sandbox-exec` 包装，策略文件先只写 read-only 版——观察 prompt injection 攻击时，恶意 `write_file`/`exec` 从"应用层拦截"升级为"内核 EPERM"。
2. **再加 workspace-write 模式**：引入可写根 + `.git` 保护，体验"两层防御"（应用层路径检查报友好错误，沙箱层兜住绕过的）。
3. **最后加网络闸门**：给 `read_webpage` 这类联网工具加开关，复现"能读 SECRET + 能联网 = 外泄"的攻防矩阵场景，然后关掉网络看攻击断链。

每一步都对应你已学的攻击场景，沙箱立刻有可观察的防御效果——这比抄 Codex 的配置有用得多。
