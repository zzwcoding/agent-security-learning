# 25: m12 mcp-audit 对齐 MCP 官方 SDK——手写 JSON-RPC 换官方 Client（回补票）

**What to build:** packages/mcp-audit 的手写 JSON-RPC transports（stdio readline 握手 + streamable HTTP/SSE 手解析）替换为 @modelcontextprotocol/sdk 官方 Client。audit 报告结构、toolHash、exit code、CLI 参数与 examples/ 存证契约不变。

**Blocked by:** （回补票）

**Touches modules:** `m12`

**Belongs to spec:** specs/modules.md

**Status:** ready-for-agent

- [ ] package.json 真依赖 @modelcontextprotocol/sdk，stdio 与 streamable HTTP 两条 transport 都走官方 Client（源：m12 卡 Seam·PRD §6-M12·ADR 0002）
- [ ] cursor 分页、工具清单、投毒判定（7 族规则）、tier 建议行为不变；mcp-audit 10 个既有测试语义保持全绿（源：票 05 回归）
- [ ] evil-server fixture 重跑报告与 examples/evil-server.json 结论一致（4 工具 2 投毒 2 高危口径不变）（源：票 05 验收）
- [ ] ≥1 个公开 MCP server 重跑体检报告，与 examples/ 既有存证结论不矛盾；新存证更新进 examples/（源：票 05 验收）
- [ ] 架构投影文档（如有 m12 相关）与最终形态一致（源：收尾第⑤样）
