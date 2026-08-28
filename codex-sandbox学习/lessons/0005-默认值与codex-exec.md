# 阶段 5：默认值解析与 `codex exec`

> 信源：[backgrind.com/blog/codex-cli-sandbox-modes](https://backgrind.com/blog/codex-cli-sandbox-modes/)（0.146.0）；默认值逻辑 `codex-rs/config/src/config_toml.rs` 的 `ConfigToml::derive_permission_profile`

## 一、三问（阶段动机）

**这一阶段是干嘛的？** 解决两个"不写进脚本就会咬人"的问题：什么都不配置时到底生效的是哪个模式？无头模式 `codex exec` 和交互式 TUI 的权限面差在哪？

**因为什么需求需要这么设计？** 交互式使用时，Codex 想用"目录信任"减少打扰——你信任过的目录直接给 `workspace-write`。这是**为人设计的便利**。但同一套逻辑进了脚本，默认值就变成了不可复现的抽奖。而 `codex exec` 面对的是"管道另一端没有人"，必须把审批弹窗从设计里剔除。

**解决了什么问题？** 学完后你知道：为什么"在我机器上是这个行为"不构成任何保证；为什么 CI 里的 Codex 永远不会卡在等按键上；以及哪些教程旗标已经过期。

## 二、全链路一览

```
【默认模式解析】(config_toml.rs: derive_permission_profile)

  没设 sandbox_mode?
       │
       ├── 该目录有信任决定? ──是──► workspace-write
       │                            (Windows 无沙箱时: 降级 read-only)
       └── 否 ──► SandboxMode::default() = read-only

  ⚠️ 同一 repo 两个克隆目录,行为可以不同!
  ⚠️ 交互便利 ✅ / 脚本灾难 ❌ ──► 自动化必须显式 --sandbox

【两个入口的权限面差异】

  codex (TUI)                    codex exec (无头)
  ─────────                      ────────────────
  -a/--ask-for-approval ✅有      -a 旗标 ❌不存在
  --sandbox ✅                    硬编码 approval_policy = Never
  --cd/-C, --add-dir ✅           --sandbox ✅(唯一权限旋钮)
  --yolo ✅                       --cd/-C, --add-dir, --yolo ✅
  --full-auto ❌不再解析           --full-auto 隐藏残留,只打印弃用警告
```

## 三、跟着数据走：三个"以为没问题"的真实场景

1. **本地脚本突然行为变了**：你在 `~/proj-a` 用过 Codex 并回答过信任提示，脚本在那里跑是 `workspace-write`；把同一脚本拷到 CI 全新 checkout 的目录，变成 `read-only`，agent 突然"罢工"不写文件。根因不是环境差异，是**默认值里藏着一份写在别处的状态**（信任记录）。修复：脚本里永远显式 `--sandbox`。
2. **CI 挂死三小时**：假设 `codex exec` 支持 `-a on-request`——管道另一端没有人，弹窗永远等不到回答，job 直到超时。这就是为什么 `exec` 把 `AskForApproval::Never` 硬编码在 `codex-rs/exec/src/lib.rs`（注释原话："Default to never ask for approvals in headless mode"），而且 `-a` 干脆不在这个子命令上声明（它只长在 `codex-rs/tui/src/cli.rs` 的交互命令上）。**消灭一类故障的正确方式是让组合无法表达，而不是文档提醒。**
3. **照抄旧教程报错/无效**：`codex --full-auto` 在顶层命令已经**不再解析**（直接报错）；`codex exec --full-auto` 是个隐藏的兼容陷阱，能跑但只打印 *"warning: `--full-auto` is deprecated; use `--sandbox workspace-write` instead."*。看到任何教程用 `--full-auto`，直接判定过期。

## 四、新技术点四要素

### `codex exec` 无头模式

- **名字**：非交互执行入口；prompt 作参数或 stdin 传入，进度走 stderr，最终答案走 stdout
- **作用**：给脚本/CI/其他工具驱动 Codex 用的程序化接口；权限面**刻意收窄**——这不是疏忽是设计
- **参数**：`--sandbox`/`-s`（唯一的权限旋钮）、`--cd`/`-C`、`--add-dir`、`--skip-git-repo-check`、`--json`（JSON Lines 事件流）、`-o`/`--output-last-message`、`--ephemeral`（不在 runner 盘上留 session 文件）、`--dangerously-bypass-approvals-and-sandbox`（别名 `--yolo`）
- **用法**：`codex exec --sandbox read-only "..."`——读模式+无审批，沙箱保证不改动、`never` 保证不卡死，失败=非零退出码，自动化三要素齐了

## 五、关键顿悟

- **依赖外部隐式状态的默认值不可复现**。"目录信任"是交互式 UX 的合理妥协，但任何会进脚本的行为都必须能显式钉死——评估别的工具时，"默认值从哪来"是必查项。
- **`exec` 砍掉 `-a` 是 API 设计的高级手法**：与其文档里写"headless 别用 on-request"，不如让这个组合在类型层面不存在。你自己设计 agent 的 CLI 时照抄：不可能的组合应该不可能表达。
- **弃用旗标的两种死法**值得对比：`--full-auto` 在 TUI 是硬删（报错），在 exec 是软删（警告+映射）——选择取决于"那条路径上跑着多少存量自动化"。

## 六、举例补充（三个终端剧本）

### 剧本 1：默认值为什么"漂移"

```bash
# 周一,你在老目录用过 codex,它问过"信任这个目录吗",你答了"是"
cd ~/code/proj-a
codex "帮我重构 login 函数"     # 生效: workspace-write ✅ 能改文件

# 周五,同事让你看看新克隆的仓库,同一个项目,不同路径
cd /tmp/proj-a-review
codex "帮我重构 login 函数"     # 生效: read-only ❌ 只给建议,不动文件
```

**同一个人、同一个项目、同一条命令、同一台机器**——行为不同。区别只在于：第一个目录的信任记录躺在 Codex 的配置里，第二个目录没有。这就是"默认值不是常量"：**它偷偷依赖一份写在别处的状态（目录信任记录），而你看不见。** 所以脚本里必须写死：

```bash
codex exec --sandbox workspace-write "帮我重构 login 函数"   # 哪个目录跑都一样
```

### 剧本 2：`exec` 为什么没有 `-a`

假设它存在，CI 里会这样：

```yaml
# .github/workflows/review.yml(假想)
- run: codex exec -a on-request "review 这个 PR"
```

agent 跑到一半想写文件 → 打印一行 "Approve? [y/N]" → **CI 的终端没有键盘** → 进程永远停在这一行 → 三小时后 GitHub 超时杀 job。你损失三小时队列时间，得到零输出。

Codex 的解法是**让这个错误根本无法写出来**：

```bash
codex exec -a on-request "review 这个 PR"
# error: unexpected argument '-a' found        ← 旗标不存在,直接报错
```

`exec` 内部写死 `approval_policy = Never`：agent 想越沙箱 → 不弹窗 → 把"被拒"这句话回喂给模型 → 模型带着约束继续干活或输出失败结论 → CI 拿到结果或非零退出码。**对比：TUI 留 `-a` 是因为终端前坐着人；exec 砍 `-a` 是因为管道另一端没人。**

### 剧本 3：`--full-auto` 的两种死法

```bash
# 死法一(硬删):交互式命令上,它已经不是合法旗标
codex --full-auto "..."
# error: unexpected argument '--full-auto' found   ← 立刻报错,逼你改

# 死法二(软删):exec 上还留着一具"尸体"
codex exec --full-auto "..."
# warning: `--full-auto` is deprecated; use `--sandbox workspace-write` instead.
# (然后按 workspace-write 继续跑)                  ← 老脚本不死,但你被提醒
```

为什么同一个旗标两种待遇？**TUI 是人手敲的，报错成本是重敲一次；exec 跑在无数存量 CI 脚本里，硬删会一夜打爆别人的流水线。** 软删给迁移期，硬删给终局。

