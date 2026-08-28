# 0005 — 阶段 5：默认值与 codex exec

- **日期**：2026-08-28
- **学了什么**：默认值解析（无配置时：目录有信任→workspace-write，无→read-only，Windows 无沙箱再降级）→ 自动化必须显式 `--sandbox`；`codex exec` 无 `-a` 旗标且硬编码 `Never`（不可能的组合不可表达的设计手法）；`--full-auto` 在 TUI 硬删、exec 软删；exec 关键旗标（--json/-o/--ephemeral/--skip-git-repo-check）。
- **卡在哪**：无。
- **结论**：落盘 `lessons/0005-默认值与codex-exec.md`。下一步阶段 6（四个实战配方 + 收官）。
- **信源落点**：`config/src/config_toml.rs`、`exec/src/lib.rs`、`tui/src/cli.rs`。
