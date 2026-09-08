// 分页 fixture MCP server（stdio，手写最小 JSON-RPC）：5 个干净工具分 3 页（每页 2 个）。
// 票 25 新增——官方 Client 的 cursor 翻页循环必须把清单收全；与投毒检测无关，全部工具干净。
// 仅本仓测试用。游标就是「下一个起点」的十进制字符串，故意最简（游标对客户端不透明）。
import readline from "node:readline";

const tools = Array.from({ length: 5 }, (_, i) => ({
  name: `paged_tool_${i + 1}`,
  description: `Read-only paged tool number ${i + 1}.`,
  inputSchema: { type: "object", properties: {} },
}));
const PAGE_SIZE = 2;

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (!msg || msg.id === undefined) return; // notification：无 id 不回
  let result;
  if (msg.method === "initialize") {
    result = {
      protocolVersion: msg.params?.protocolVersion ?? "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "paged-tools", version: "1.0.0" },
    };
  } else if (msg.method === "tools/list") {
    const start = Number(msg.params?.cursor ?? 0);
    result = { tools: tools.slice(start, start + PAGE_SIZE) };
    if (start + PAGE_SIZE < tools.length) result.nextCursor = String(start + PAGE_SIZE);
  } else if (msg.method === "ping") {
    result = {};
  } else {
    res(msg.id, { error: { code: -32601, message: "method not found" } });
    return;
  }
  res(msg.id, result);
});
function res(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}
