// MCP transport adapter（FR-M12.1，m12 卡 Seam：stdio/sse 各一）。
// 票 25（ADR 0002 框架回补第三票）：JSON-RPC 分帧、initialize 握手、SSE 解析、
// mcp-session-id 管理全部交给 @modelcontextprotocol/sdk 官方 Client——
// 票 05 手写的 spawn+readline 与 streamable HTTP 手解析退场。
// 本文件只剩「选 transport → connect → 翻页收 tools/list → 拼对内 McpManifest」这层薄适配。
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

/** tools/list 的 wire 形（票 43·F5 收敛：与 tier.ts 的两处手抄并成这一份定义）。 */
export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: object;
}

export interface McpManifest {
  server: string;
  version?: string;
  transport: "stdio" | "http";
  tools: McpTool[];
}

export function isHttpTarget(target: string): boolean {
  return /^https?:\/\//.test(target);
}

export async function listTools(target: string, timeoutMs: number): Promise<McpManifest> {
  return isHttpTarget(target) ? listToolsOverHttp(target, timeoutMs) : listToolsOverStdio(target, timeoutMs);
}

function withTimeout<T>(p: Promise<T>, ms: number, what = "target"): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`${what} timeout after ${ms}ms`)), ms)),
  ]);
}

// 官方 SDK 只管单页：listTools 按协议回一页 + nextCursor（游标对客户端不透明），
// 翻到底的循环仍归我们——这正是 MCP 分页契约的分工。
async function collectTools(
  client: Client,
  transport: Transport,
  fallbackName: string,
  kind: "stdio" | "http",
  timeoutMs: number,
): Promise<McpManifest> {
  try {
    // initialize 握手 + notifications/initialized 由 SDK 发；连接失败就地抛错（→ unreachable）
    await client.connect(transport, { timeout: timeoutMs });
    const info = client.getServerVersion();
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : {}, { timeout: timeoutMs });
      tools.push(...page.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })));
      cursor = page.nextCursor;
    } while (cursor);
    return {
      server: info?.name ?? fallbackName,
      version: info?.version,
      transport: kind,
      tools,
    };
  } finally {
    await client.close().catch(() => undefined);
  }
}

// ---- stdio：官方 StdioClientTransport 负责 spawn、按行分帧、协议握手 ----
export function listToolsOverStdio(command: string, timeoutMs: number): Promise<McpManifest> {
  const [file, ...args] = command.trim().split(/\s+/);
  // stderr: "ignore" 保持票 05 行为——server 的 stderr 噪音不污染 CLI 输出
  const transport = new StdioClientTransport({ command: file, args, stderr: "ignore" });
  const client = new Client({ name: "soc-mcp-audit", version: "0.1.0" });
  return withTimeout(collectTools(client, transport, file, "stdio", timeoutMs), timeoutMs);
}

// ---- streamable HTTP：官方 StreamableHTTPClientTransport 负责 POST/SSE 双兼容与 session-id ----
export async function listToolsOverHttp(url: string, timeoutMs: number): Promise<McpManifest> {
  const transport = new StreamableHTTPClientTransport(new URL(url));
  const client = new Client({ name: "soc-mcp-audit", version: "0.1.0" });
  return withTimeout(collectTools(client, transport, new URL(url).host, "http", timeoutMs), timeoutMs);
}
