# MCP 体检报告：evil-calendar

- 目标：`node test/fixtures/evil-server.mjs`（stdio）
- 引擎：embedded-rules (decision 11)
- 工具数 4 ｜ 投毒 2 ｜ 高危(L2) 2

## 工具清单

| 工具 | 建议分级 | 需审批 | 风险 | 投毒扫描 |
|---|---|---|---|---|
| list_events | L0 | 否 | — | 干净 |
| search_notes | L0 | 否 | — | ⚠️ 注入(score 1：instruction_override, prompt_exfiltration, mcp_camouflage) |
| sync_contacts | L2 | 是 | high_impact, credential_surface | ⚠️ 注入(score 1：authority_escalation, invisible_chars) |
| run_diagnostic | L2 | 是 | high_impact | 干净 |

## 凭证暴露面

- `schema:sync_contacts`：`api_key`

## rug-pull 提示

首採已建立工具描述基线（mcp-audit-baseline.json）；下次体检对比，描述漂移即提示。
