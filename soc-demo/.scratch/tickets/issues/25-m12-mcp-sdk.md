# 25: m12 mcp-audit 对齐 MCP 官方 SDK——手写 JSON-RPC 换官方 Client（回补票）

**What to build:** packages/mcp-audit 的手写 JSON-RPC transports（stdio readline 握手 + streamable HTTP/SSE 手解析）替换为 @modelcontextprotocol/sdk 官方 Client。audit 报告结构、toolHash、exit code、CLI 参数与 examples/ 存证契约不变。

**Blocked by:** （回补票）

**Touches modules:** `m12`

**Belongs to spec:** specs/modules.md

**Status:** done

### 执行记录（2026-09-08，编码窗口）

1. **SDK 落地形态**：@modelcontextprotocol/sdk **1.30.0**（当前 stable，锁进 pnpm-lock.yaml）。transports.ts 重写为官方 Client：stdio=StdioClientTransport（stderr:"ignore" 保持票 05 噪音吞掉行为）、streamable HTTP=StreamableHTTPClientTransport（session-id/SSE 双兼容全归 SDK）；协议版本随 SDK 升到 2025-11-25（旧手写是 2024-11-05），握手/分帧细节全部交官方，对内 `listTools/listToolsOverStdio/listToolsOverHttp/isHttpTarget/McpManifest` 签名不变，audit.ts/cli.ts/index.ts 零改动。
2. **分页分工如实记录（票面迁移建议 vs SDK 实情）**：SDK 的 `client.listTools()` 按协议返回**单页 + nextCursor**，不做自动翻底——「翻到底」的游标循环仍归调用方（这是 MCP 分页契约的设计分工：游标对客户端不透明）。本票保留该循环（19 行级实现），wire 层的请求分帧/握手/解析全在 SDK 内。非手写回退，特此留痕。新增 paged-stdio-server.mjs fixture（5 工具分 3 页）+ 官方 Server↔官方 Client streamable HTTP 端到端测试，证明翻底与 HTTP 载体行为。
3. **公开 server 存证重跑**：filesystem（14 工具/高危 1/投毒 0）、memory（9/3/0）、sequential-thinking（1/0/0），与 examples/ 既有存证 **JSON 逐字段相同**（无版本漂移），examples/ 零 diff——存证由 SDK 载体重生成后原样成立。evil-server fixture 同口径（4 工具/投毒 2/高危 2，exit 1）。
4. **无 spec 出入**：m12 卡 Seam 描述（stdio/sse 各一 adapter）与实现一致；arch-notes.json m12 卡补了一句 SDK 载体说明（投影同步，票 24 先例）。

- [x] package.json 真依赖 @modelcontextprotocol/sdk，stdio 与 streamable HTTP 两条 transport 都走官方 Client（源：m12 卡 Seam·PRD §6-M12·ADR 0002）
- [x] cursor 分页、工具清单、投毒判定（7 族规则）、tier 建议行为不变；mcp-audit 10 个既有测试语义保持全绿（源：票 05 回归）
- [x] evil-server fixture 重跑报告与 examples/evil-server.json 结论一致（4 工具 2 投毒 2 高危口径不变）（源：票 05 验收）
- [x] ≥1 个公开 MCP server 重跑体检报告，与 examples/ 既有存证结论不矛盾；新存证更新进 examples/（源：票 05 验收）
- [x] 架构投影文档（如有 m12 相关）与最终形态一致（源：收尾第⑤样）
