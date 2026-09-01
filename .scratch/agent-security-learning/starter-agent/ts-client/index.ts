/**
 * ts-second-agent —— 路线 3 阶段 36 的第二消费者(锚点件)。
 *
 * 它是"第二个身份":和 Python 起步 Agent 消费同一个网关,
 * 证明两件事——① TS 是 MCP 生态一等公民(官方 typescript-sdk);
 * ② 授权矩阵"人×Agent×工具×资源"里 Agent 这一维有了第二个样本,
 *    阶段 37-38 给它配只读权限后,越权调用就该在这里被网关拒掉。
 *
 * 运行(网关与上游已在跑的前提下):
 *   GATEWAY_TOKEN=$(../scripts/mint-gateway-token.sh) npx tsx index.ts
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const GATEWAY_URL = process.env.GATEWAY_URL ?? "http://127.0.0.1:4444/mcp";
const token = process.env.GATEWAY_TOKEN;
if (!token) {
  console.error("缺少 GATEWAY_TOKEN:先在 starter-agent 目录跑 scripts/mint-gateway-token.sh");
  process.exit(1);
}

// streamable HTTP 传输:和 Python 侧的 streamablehttp_client 同协议,
// 网关只有一个门,谁来讲方言都行——这正是"MCP 是协议层粘合剂"的意思。
const transport = new StreamableHTTPClientTransport(new URL(GATEWAY_URL), {
  requestInit: { headers: { Authorization: `Bearer ${token}` } },
});

const client = new Client({
  name: "ts-second-agent", // 这个名字会出现在网关日志/审计里:第二个身份可见
  version: "0.1.0",
});

async function main() {
  await client.connect(transport);
  console.log(`✅ 已连上网关 ${GATEWAY_URL}(身份:ts-second-agent)`);

  // ① 看目录:网关返回的是带前缀的全局工具表,和 Python 侧看到的同一份
  const { tools } = await client.listTools();
  console.log(`✅ 网关工具表(${tools.length} 个):`);
  for (const t of tools) console.log(`   ${t.name} — ${(t.description ?? "").slice(0, 40)}`);

  // ② 真调一个:只读工具,恰好是这个"第二身份"未来被允许的范围
  const result = await client.callTool({ name: "filesystem-list-dir", arguments: { path: "." } });
  const text = (result.content as Array<{ type: string; text?: string }>)
    .map((b) => b.text ?? "")
    .join("\n");
  console.log("✅ filesystem-list-dir(.) 经网关执行返回:");
  console.log(text);

  await client.close();
  console.log("👋 连接已关闭(短连接,不留常驻会话)");
}

main().catch((err) => {
  console.error("❌ 失败:", err instanceof Error ? err.message : err);
  process.exit(1);
});
