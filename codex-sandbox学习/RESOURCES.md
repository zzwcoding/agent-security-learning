# RESOURCES — 信源清单

## 主信源（本课程讲解的原文）

- [Codex CLI sandbox modes, explained (Backgrind, Andrew Mercer, 2026-08-02)](https://backgrind.com/blog/codex-cli-sandbox-modes/)
  - 文章自称验证版本：`@openai/codex` **0.146.0**（npm `latest`，tag `rust-v0.146.0`，2026-07-29 发布）
  - 校验日期 2026-08-02，对照 github.com/openai/codex 源码
  - ⚠️ 这部分代码迭代极快，动手前用 `codex --help` 复核旗标名

## 文中引用的源码位置（讲解论断的落点）

| 论断 | 源码文件 |
|---|---|
| 三种 SandboxMode 定义 | `codex-rs/protocol/src/config_types.rs` |
| CLI 沙箱旗标映射 | `codex-rs/utils/cli/src/sandbox_mode_cli_arg.rs` |
| macOS Seatbelt 基础策略（`(deny default)` 开局） | `codex-rs/sandboxing/src/seatbelt_base_policy.sbpl` |
| macOS 网络叠加策略 | `seatbelt_network_policy.sbpl` |
| 平台后端选择 | `codex-rs/sandboxing/src/manager.rs` (`get_platform_sandbox()`) |
| Linux bubblewrap 行为说明 | `codex-rs/linux-sandbox/README.md` |
| 受保护元数据目录 `.git`/`.agents`/`.codex` | `codex-rs/protocol/src/permissions.rs` (`PROTECTED_METADATA_PATH_NAMES`) |
| AskForApproval 取值 | `codex-rs/protocol/src/protocol.rs` |
| 沙箱×审批组合行为 | `codex-rs/core/src/safety.rs` |
| Windows 静默降级 read-only | `codex-rs/config/src/config_toml.rs` |
| Windows 沙箱配置解析 | `codex-rs/core/src/windows_sandbox.rs` |
| `codex exec` 硬编码 `never` | `codex-rs/exec/src/lib.rs` |
| `-a` 仅存在于交互式命令 | `codex-rs/tui/src/cli.rs` |

## 官方文档

- `developers.openai.com/codex`（现重定向到 `learn.chatgpt.com/docs`）
