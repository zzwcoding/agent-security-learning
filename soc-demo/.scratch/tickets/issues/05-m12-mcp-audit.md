# 05: m12 MCP 体检 CLI

**What to build:** 独立 npm bin：soc-mcp-audit <cmd-or-url> 静态体检 MCP server（投毒描述/权限面/凭证暴露/rug-pull），产出 mcp-audit-report.{md,json}。扫描规则本地内嵌，可独立跑。

**Blocked by:** None (can start immediately)

**Touches modules:** `m12`

**Belongs to spec:** specs/modules.md

**Status:** ready-for-agent

- [ ] soc-mcp-audit <cmd-or-url> 产出 mcp-audit-report.{md,json}（源：m12 卡公开接口）
- [ ] ≥3 公开 server + 1 内置恶意 fixture server 投毒 100% 检出（源：m12 卡测试计划）
- [ ] 扫描规则本地内嵌、不依赖运行时 guards（源：决策记录 #11）
