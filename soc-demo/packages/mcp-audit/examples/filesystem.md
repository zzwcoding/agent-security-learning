# MCP 体检报告：secure-filesystem-server

- 目标：`npx -y @modelcontextprotocol/server-filesystem /tmp`（stdio）
- 引擎：embedded-rules (decision 11)
- 工具数 14 ｜ 投毒 0 ｜ 高危(L2) 1

## 工具清单

| 工具 | 建议分级 | 需审批 | 风险 | 投毒扫描 |
|---|---|---|---|---|
| read_file | L0 | 否 | — | 干净 |
| read_text_file | L0 | 否 | — | 干净 |
| read_media_file | L2 | 是 | high_impact | 干净 |
| read_multiple_files | L0 | 否 | — | 干净 |
| write_file | L1 | 否 | write_operation | 干净 |
| edit_file | L1 | 否 | write_operation | 干净 |
| create_directory | L1 | 否 | write_operation | 干净 |
| list_directory | L0 | 否 | — | 干净 |
| list_directory_with_sizes | L0 | 否 | — | 干净 |
| directory_tree | L0 | 否 | — | 干净 |
| move_file | L1 | 否 | write_operation | 干净 |
| search_files | L0 | 否 | — | 干净 |
| get_file_info | L0 | 否 | — | 干净 |
| list_allowed_directories | L0 | 否 | — | 干净 |

## 凭证暴露面

未发现明文凭证模式。

## rug-pull 提示

首採已建立工具描述基线（mcp-audit-baseline.json）；下次体检对比，描述漂移即提示。
