# MCP 体检报告：memory-server

- 目标：`npx -y @modelcontextprotocol/server-memory`（stdio）
- 引擎：embedded-rules (decision 11)
- 工具数 9 ｜ 投毒 0 ｜ 高危(L2) 3

## 工具清单

| 工具 | 建议分级 | 需审批 | 风险 | 投毒扫描 |
|---|---|---|---|---|
| create_entities | L1 | 否 | write_operation | 干净 |
| create_relations | L1 | 否 | write_operation | 干净 |
| add_observations | L0 | 否 | — | 干净 |
| delete_entities | L2 | 是 | high_impact | 干净 |
| delete_observations | L2 | 是 | high_impact | 干净 |
| delete_relations | L2 | 是 | high_impact | 干净 |
| read_graph | L0 | 否 | — | 干净 |
| search_nodes | L0 | 否 | — | 干净 |
| open_nodes | L0 | 否 | — | 干净 |

## 凭证暴露面

未发现明文凭证模式。

## rug-pull 提示

首採已建立工具描述基线（mcp-audit-baseline.json）；下次体检对比，描述漂移即提示。
