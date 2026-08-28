# 阶段 4：approval policy 与组合矩阵

> 信源：[backgrind.com/blog/codex-cli-sandbox-modes](https://backgrind.com/blog/codex-cli-sandbox-modes/)（0.146.0）；取值定义 `codex-rs/protocol/src/protocol.rs`，组合行为 `codex-rs/core/src/safety.rs`

## 一、三问（阶段动机）

**这一阶段是干嘛的？** 拧开阶段 1 说的"旋钮 2"：审批策略有几个取值、各自什么行为，以及它和旋钮 1 组合后**实际体感**是什么。

**因为什么需求需要这么设计？** 同一个沙箱，不同场景要的交互密度完全不同：配对编程时弹个窗无所谓，CI 里弹窗等于挂死。所以"被沙箱挡住后怎么办"必须是个独立可调的参数，而不是焊死的行为。

**解决了什么问题？** 网上大量过时信息在这一层：`on-failure` 已经没了、`granular` 在 CLI 上选不了。学完你能识别过期教程，并且会为场景选组合而不是背默认值。

## 二、全链路一览

```
AskForApproval (protocol/src/protocol.rs)
│
├── untrusted    只有"已知安全"的只读命令自动跑,其余全问
├── on-request   【默认】沙箱内自由跑,想越沙箱才问
├── never        永不询问;被挡=失败回喂模型
└── granular     结构体(非CLI值): sandbox_approval / rules / skill_approval
                 三个分类布尔,false=自动拒而非弹窗

CLI 的 --ask-for-approval 只暴露前三个 ──► granular 只能写进 config.toml
已废弃: on-failure ──► 只剩 serde 别名,反序列化成 on-request(静默变义!)
```

## 三、跟着数据走：agent 想写可写根外的文件，五种组合五种命运

场景固定：**一个 patch 要写到 writable_roots 之外**（判定逻辑在 `core/src/safety.rs`）。

1. **`read-only` + `never`**：不弹窗，硬拒绝，回喂文案 *"writing is blocked by read-only sandbox; rejected by user approval settings"*。模型读懂"重试没用"，改为输出建议让用户自己改。**这是无人值守场景的标准形态**：失败=消息+非零退出，不是无限等待。
2. **`read-only` + `on-request`**：弹窗问你。你点同意，这次写入**在沙箱外**执行成功——注意，approval 的"是"本质是"临时越过沙箱"。
3. **`workspace-write` + `never`**：根内写入静默通过；根外写入直接拒。日常无人打扰的上限形态。
4. **`workspace-write` + `untrusted`**：连沙箱本来放行的普通命令也先问你。**这是本阶段最重要的反直觉点**：`untrusted` 没有让系统更安全（沙箱边界没变），只是让它更吵。
5. **`danger-full-access` + `never`**：没有任何东西拦任何东西。唯一可辩护的场景：外面已经有别的沙箱（一次性容器、无凭据的 CI runner）——这正是 `--dangerously-bypass-approvals-and-sandbox` 帮助文本的原话。

**结论句**：想要"安静的安全"，答案是**更紧的沙箱 + `never`**，不是更响的审批策略。

## 四、新技术点四要素

### `AskForApproval` 枚举

- **名字**：审批策略，Rust 枚举 `AskForApproval`（`codex-rs/protocol/src/protocol.rs`）；CLI `-a`/`--ask-for-approval`，配置 `approval_policy`
- **作用**：只决定"被沙箱挡住后的流程"，**不产生安全边界**（阶段 1 的旋钮分离在此落地）
- **参数**：CLI 三值 `untrusted`/`on-request`/`never`；`granular` 是配置专属的结构体（`sandbox_approval`、`rules`、`skill_approval` 三个分类开关，`false` = 自动拒），CLI 枚举里**没有**它
- **用法**：日常 `on-request`；自动化 `never`；`untrusted` 只在"不信任当前任务本身"时用
- **版本陷阱**：老配置里的 `approval_policy = "on-failure"` 现在仍能加载（serde 别名），但语义已静默变成 `on-request`——评估/迁移旧配置时要当心这种"不报错但变义"的兼容方式

## 五、关键顿悟

- **审批是交互策略，不是安全策略。** 判断一个组合安不安全，只看沙箱那一列；审批列决定的是"你会被弹几次窗"和"失败长什么样"。
- **`never` 的价值在无人值守**：它把"等不到按键的挂死"变成"非零退出+消息"，这是自动化唯一能处理的失败形态。
- **沉默的别名是配置债**：`on-failure` → `on-request` 的静默映射提醒我们，评估 agent 产品的配置兼容性时，"能加载"≠"语义没变"。
