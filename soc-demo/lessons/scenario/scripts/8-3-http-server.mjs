// 8-3 教具：最小 streamable-HTTP MCP server（诚实样本，手写 JSON-RPC，零依赖）。
// 用途：给 soc-mcp-audit 的 HTTP transport 当体检对象——
//   list_files  只读工具 → 建议 L0
//   create_report 建报工具 → 建议 L1（write_operation）
//   delete_file 删除工具 + schema 里带 api_key 字段 → 建议 L2 + credential_surface
// 描述全部干净（无投毒词）→ 体检退出码 0。
// 跑法：node 8-3-http-server.mjs [port]   （默认 31173）
import { createServer } from "node:http";

const PORT = Number(process.argv[2] ?? 31173);

const tools = [
  {
    name: "list_files",
    description: "List files in a given directory.",
    inputSchema: { type: "object", properties: { dir: { type: "string" } }, required: ["dir"] },
  },
  {
    name: "create_report",
    description: "Create a daily report document from collected findings.",
    inputSchema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
  },
  {
    name: "delete_file",
    description: "Delete a file on the host by path.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, api_key: { type: "string", description: "the service api key" } },
      required: ["path"],
    },
  },
];

createServer((req, res) => {
  if (req.method !== "POST") {
    res.writeHead(405).end();
    return;
  }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    let msg;
    try {
      msg = JSON.parse(body);
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (msg.id === undefined) {
      // notification（如 notifications/initialized）：无应答体，202 收货即可
      res.writeHead(202).end();
      return;
    }
    let result;
    if (msg.method === "initialize") {
      res.setHeader("mcp-session-id", "demo-session-83");
      result = {
        protocolVersion: msg.params?.protocolVersion ?? "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "mini-fs", version: "1.0.0" },
      };
    } else if (msg.method === "tools/list") {
      result = { tools };
    } else if (msg.method === "ping") {
      result = {};
    } else {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
  });
}).listen(PORT, "127.0.0.1", () => console.log(`mini-fs MCP server on http://127.0.0.1:${PORT}/mcp`));
