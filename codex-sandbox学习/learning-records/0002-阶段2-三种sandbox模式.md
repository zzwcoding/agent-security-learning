# 0002 — 阶段 2：三种 sandbox 模式

- **日期**：2026-08-28
- **学了什么**：三档模式的写盘/网络/进程矩阵；read-only 显式放行 process-exec/fork（"能跑不能写"）；workspace-write 的可写根模型 + `.git`/`.agents`/`.codex` 受保护（防 `.git/hooks` 提权）；网络默认关且是独立闸门。
- **卡在哪**：无。
- **结论**：落盘 `lessons/0002-三种sandbox模式.md`。下一步等用户指令进阶段 3（各 OS 强制实现）。
- **信源落点**：`protocol/src/config_types.rs`、`sandboxing/src/seatbelt_base_policy.sbpl`、`protocol/src/permissions.rs`、`linux-sandbox/README.md`。
