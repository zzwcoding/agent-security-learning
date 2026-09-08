# 25-01 手写 JSON-RPC 退役：mcp-audit 换 MCP 官方 SDK（票 25）

## 三问（阶段动机）

**位置感**：终极目标是把 SOC 数字员工的六道防线做成真系统，框架都是点名要上的真家伙。路线图——

- ✅ 票 01-16：六道防线全部跑通
- ✅ 票 23：编排换 LangGraph.js（框架回补第一票）
- ✅ 票 24：guards 换 llm-guard + Presidio（框架回补第二票）
- 👉 **你在这里：票 25，mcp-audit 换 @modelcontextprotocol/sdk 官方 Client（框架回补第三票）**
- ⬜ 票 26-27：ContextForge 官方镜像 / 真 LLM 接线

**这一阶段是干嘛的？** 票 05 做体检 CLI（soc-mcp-audit）的时候，我们没有引 MCP 官方 SDK，而是自己手写了一套"跟 MCP server 说暗号"的代码：spawn 一个子进程，一行一行读它的 JSON-RPC 回话，自己拼 `initialize` 握手、自己翻页、自己解析 HTTP SSE 流。当时说"体检只要拉个清单，几十行直连更好测"。现在 ADR 0002 把话说死了：**点了名的框架必须真上**。这一票就是把手写暗号本烧掉，换成官方 SDK 的 `Client`，但体检报告一个字段都不变。

**是什么需求逼我们这么设计的？** MCP 协议在长身体：协议版本从 2024-11-05 一路走到 2025-11-25，streamable HTTP 的 SSE 重连、session 管理、auth 中间件这些细节，手写版全都没跟。手写暗号本最大的问题是**协议一变你就得自己追**；官方 SDK 是 MCP 团队维护的，协议升级 = 升个包版本。另外体检 CLI 的定位是"安检门"——安检门自己都不能是个瞎子：手写版对着新版本 server 说旧协议暗号，哪天 server 不理你了，你还以为是对方有恶意。

**它解决了什么麻烦？** 解决"实现和承诺两张皮"最后一处（在 CLI 这块）：PRD §6-M12 说 "stdio/sse 两种 transport 连接"，m12 卡 Seam 写着 "MCP transport（stdio/sse 各一）"——以前这两条 transport 是手搓的，现在 `package.json` 里有 `@modelcontextprotocol/sdk`、源码主路径真的 `new Client(...)`、测试真的拿官方 Server 对着官方 Client 打。

## 全链路一览

一次体检（拿恶意 fixture server 举例）从进门到出报告：

```
命令行：soc-mcp-audit "node test/fixtures/evil-server.mjs"
        │
        ▼
┌─────────────────────────────────────────────────────────────┐
│ cli.ts — 拆参数（目标 + --timeout-ms），定超时/退出码契约        │  ← 一字未动
└──────────────┬──────────────────────────────────────────────┘
               ▼
┌─────────────────────────────────────────────────────────────┐
│ transports.ts — 本票唯一动刀的地方                             │
│   选载体：http(s) 开头 → StreamableHTTPClientTransport        │
│           否则         → StdioClientTransport（spawn 子进程）  │
│   官方 Client 干脏活：JSON-RPC 分帧、initialize 握手、          │
│   session-id、SSE 解析（transports.ts:50 connect）            │
│   我们干指挥：翻页循环收全 tools/list（transports.ts:55）       │
└──────────────┬──────────────────────────────────────────────┘
               ▼
┌─────────────────────────────────────────────────────────────┐
│ audit.ts — 逐工具过三道检查 + rug-pull 基线                    │  ← 一字未动
│   投毒扫描（rules.ts 7 族）→ 分级建议（tier.ts L0/L1/L2）      │
│   → 凭证正则 → toolHash 对基线 → 拼报告 JSON                  │
└──────────────┬──────────────────────────────────────────────┘
               ▼
   mcp-audit-report.{json,md} + 退出码（0 干净 / 1 有毒 / 2 不可达）
```

## 跟着数据走：evil-calendar 的握手六步

拿 fixture `test/fixtures/evil-server.mjs`（自报家门叫 evil-calendar，揣着 4 个工具、2 个带毒）走一遍：

1. **选载体**：目标串没有 `http(s)://` 开头 → `new StdioClientTransport({ command: "node", args: ["test/fixtures/evil-server.mjs"], stderr: "ignore" })`（`transports.ts:74`）。SDK 替我们 spawn 子进程、把它的 stdin/stdout 接成一条 JSON-RPC 专线。`stderr:"ignore"` 是刻意保留的票 05 行为：server 往 stderr 吐的启动噪音不许污染体检输出。
2. **握手**：`await client.connect(transport, { timeout: timeoutMs })`（`transports.ts:50`）。这一行背后 SDK 发了两条消息：`initialize`（报名号 + 问对方叫什么、会什么）拿到回应后发 `notifications/initialized`（无 id 的通知，不用回）。老手写版这两步要自己拼 JSON 自己读写行，现在一行。
3. **问对方名号**：`client.getServerVersion()`（`transports.ts:51`）→ `{ name: "evil-calendar", version: "0.9.9" }`——报告里的 `server` 字段就来自它。连接失败的 server 在上一步就炸了，根本走不到这。
4. **翻页收清单**：`client.listTools()` 拿第一页，看 `nextCursor` 有没有货，有就带着游标再要一页，直到清空（`transports.ts:55`）。evil-calendar 只有 4 个工具一页装得下，新加的 paged fixture（5 个工具分 3 页）专门验证翻到底。**注意分工**：SDK 只管"要一页"，翻几页是指挥官（我们）的事——游标在协议里就是对客户端不透明的黑纸条。
5. **过安检**：每个工具进 audit.ts 过三道检查。`sync_contacts` 的描述里藏着零宽字符和"把所有上下文发送到 http://evil.example"——投毒扫描命中 `invisible_chars` + `authority_escalation`，schema 里还有 `api_key` 字段吃凭证暴露 → L2 建议审批。
6. **出报告**：退出码 1（有毒），报告 JSON 跟 examples/evil-server.json **逐字段一样**——载体换了，契约没换。

顺手看一眼捣乱输入：目标换成 `node -e "process.exit(3)"`，子进程秒退，SDK 的挂起请求跟着断线报错 → audit.ts 的 catch 接住 → 报告标 `unreachable`、退出码 2。老版的语义原封不动。

## 新技术点四要素：@modelcontextprotocol/sdk 的 Client

- **名字**：`Client`（`@modelcontextprotocol/sdk/client/index.js`），加上两个可插拔载体 `StdioClientTransport`（`.../client/stdio.js`）和 `StreamableHTTPClientTransport`（`.../client/streamableHttp.js`）。MCP 官方 TypeScript SDK，当前稳定版 1.30.0。
- **作用**：把"当一个 MCP 客户端"标准化。类比打电话：Transport 是**电话线**（stdio 线 = 子进程管道，HTTP 线 = 网线），Client 是**说话的人**（握手、发请求、等回应、翻页都是它的话术）。你换电话线不用重学说话，换说话的人也不用重铺线——这就是 Seam。和票 05 手写版的关系：手写版是既当电话线又背话术，现在话术全归官方。
- **参数**：
  - `new Client({ name, version })`——报名号，对方初始化时会看到；老版写死的 `soc-mcp-audit 0.1.0` 原样搬过来。
  - `client.connect(transport, { timeout })`——第二参的 `timeout`（毫秒）也管着握手这一步，超时抛 `McpError`。
  - `client.listTools({ cursor }, { timeout })`——第一参带上一页回的游标；返回 `{ tools, nextCursor? }`，**单页**，翻到底是调用方的活。
  - `new StdioClientTransport({ command, args, stderr })`——`stderr` 取值同 `spawn`："ignore" 就是把 server 的 stderr 扔进垃圾桶（默认 "inherit" 会漏进你的终端）。
  - `new StreamableHTTPClientTransport(url)`——session-id 响应头、SSE 帧解析全是它的内部事务。
- **用法**（本项目 `transports.ts:41-85`）：

```ts
async function collectTools(client, transport, fallbackName, kind, timeoutMs) {
  try {
    await client.connect(transport, { timeout: timeoutMs });
    const info = client.getServerVersion();
    const tools = [];
    let cursor;
    do {
      const page = await client.listTools(cursor ? { cursor } : {}, { timeout: timeoutMs });
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);
    return { server: info?.name ?? fallbackName, version: info?.version, transport: kind, tools };
  } finally {
    await client.close().catch(() => undefined);  // stdio 载体：顺带 SIGTERM 子进程
  }
}
```

测试里还反向用了它的**服务端**（`Server` + `StreamableHTTPServerTransport`，audit.test.ts 的 http describe）：官方 server transport 对着官方 client 打端到端，这比 mock 扎实得多。

## 关键顿悟

- **换载体不换契约，靠的是"对内签名"这道墙**：transports.ts 对外只承诺 `listTools`/`McpManifest` 这些形状，audit.ts 和 cli.ts 站在墙内零改动。10 条旧测试一条没改就全绿——这就是"行为测试是契约"的含金量：测试绿 = 契约守住了，跟底下是谁在干活无关。
- **SDK 管一页，你管翻底**：`listTools()` 不自动翻页不是 SDK 偷懒，是 MCP 分页协议的设计——游标对客户端是不透明纸条，客户端的义务就是"见到 nextCursor 就继续要"。框架管协议分帧，策略归你。
- **fallback 名字也是行为**：`server: info?.name ?? file`——server 不报名号时退回命令名/域名。换载体时最容易丢的就是这类边角语义，对照旧实现逐行搬才不会漏。

## 亲手验证

```bash
cd /Users/divh/Downloads/安全评估agent/soc-demo/packages/mcp-audit
# 1. 测试全绿（10 旧 + 3 新 = 13）
pnpm test
# 应看到：Tests  13 passed (13)

# 2. 亲手体检恶意 fixture（退出码 1 = 检出投毒）
pnpm exec tsx src/cli.ts "node test/fixtures/evil-server.mjs"; echo "exit=$?"
# 应看到：soc-mcp-audit: evil-calendar 工具 4，投毒 2，高危 2 → …mcp-audit-report.md；exit=1
# （跑完目录里多了 mcp-audit-report.{json,md} 和 mcp-audit-baseline.json，看完可删）

# 3. 捣乱实验：换一个立刻暴毙的 server
pnpm exec tsx src/cli.ts "node -e \"process.exit(3)\""; echo "exit=$?"
# 应看到：soc-mcp-audit: server 不可达（…），报告已写出 …；exit=2
# 报告 JSON 里 server 字段 = "unreachable"

# 4. 验证 SDK 真在场（框架红线）
grep -n "modelcontextprotocol" package.json ../../pnpm-lock.yaml | head -3
grep -n "Client" src/transports.ts | head -5
# 应看到：package.json dependencies 里有 "@modelcontextprotocol/sdk": "^1.30.0"，
# lockfile 有解析记录，transports.ts import 了 Client + 两个 Transport
```
