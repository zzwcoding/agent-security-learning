# 0004 — 阶段 4：approval 与组合矩阵

- **日期**：2026-08-28
- **学了什么**：`AskForApproval` 四取值（untrusted/on-request/never/granular，granular 仅配置可写）；`on-failure` 已废仅剩 serde 别名静默映射到 on-request；五种沙箱×审批组合的实际行为；核心反直觉点——`untrusted` 让沙箱更吵而非更安全，"安静的安全"= 紧沙箱+never。
- **卡在哪**：无。
- **结论**：落盘 `lessons/0004-approval与组合矩阵.md`。下一步阶段 5（默认值解析 + codex exec）。
- **信源落点**：`protocol/src/protocol.rs`、`core/src/safety.rs`。
