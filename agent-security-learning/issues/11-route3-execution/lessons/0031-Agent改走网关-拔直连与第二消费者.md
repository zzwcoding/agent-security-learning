# 0031 - Agent 改走网关:拔直连与第二消费者登场

## 1. 三问

**位置感**:

```
✅ 34 网关上岗 → ✅ 35 三server挂网关 → ▶️ 36 Agent改走网关(你在这里) → 37 OpenFGA建模 → ...
```

**这一阶段是干嘛的?** 把 Agent 的工具表从"三个 stdio 子进程"换成"网关一个地址";直连路径从 agent.py 里拔除;再造一个 TS 写的第二消费者,让"两个 Agent 走同一个门"成真。

**什么需求逼我们这么设计?** 35 结束时网关有目录了,但 Agent 还在走后门(stdio 直连)——门修好了没人走,等于没修。"收敛"是后面一切(授权、审计、令牌)的前提:只有所有调用过同一扇门,门上的闸才有意义。

**它解决了什么麻烦?** Agent 从此不知道任何 server 的地址和启动方式——拓扑知识从 Agent 手里收走,交给了网关。这是"网关管身份"的第一块基石:下一阶段 OpenFGA 判"这个调用者能不能用这个工具",前提是调用必须路过能拦它的地方。

## 2. 全链路一览(本阶段后的最终形态)

```
                 ┌────────────────────────────────┐
   用户终端        │  ContextForge 网关 :4444 /mcp   │
 ┌──────────┐     │  (工具目录 + 认证 + 转发)        │
 │ 凭证代理   │     └───┬──────────────┬───────────┘
 │ :5055    │   streamable │              │ SSE 转发
 └────┬─────┘   HTTP 调用    │              │
      │ 注入真 key          │              ▼
 ┌────┴─────┐               │     ┌──────────────────┐
 │ 起步 Agent │ ──────────────┘     │ 三 server :8001-3 │
 │ (Python)  │  ← 第一消费者        │ (内部 shell/fetch │
 └──────────┘                      │  进一次性 microVM)│
 ┌──────────┐                      └──────────────────┘
 │ ts-client │ ────── 同一个门 ────→ (第二消费者,只读身份预备)
 └──────────┘
```

## 3. 跟着数据走:Agent 的一次工具调用(改走网关后)

1. 用户问"列出 workspace 里有哪些文件" → LLM(经凭证代理,真 key 只在代理进程)决定调工具;
2. 模型生成的工具名是 `filesystem-list-dir`——**它从出生就只认识网关目录里的名字**(带前缀);
3. agent.py 的 MultiServerMCPClient 拿 `Authorization: Bearer <GATEWAY_TOKEN>` POST 到 `http://127.0.0.1:4444/mcp`;
4. 网关验票 → 查目录 → 把调用经 SSE 转发给 8001 的 filesystem server → server 读磁盘返回;
5. 原路返回给模型,模型组织答案。
   实测输出:`工具调用 > filesystem-list-dir({"path": "."})` → `工具返回 > .env\nmeeting-notes.txt\n...`——全程没碰任何 stdio 子进程。

## 4. 新技术点四要素

### MultiServerMCPClient 的 streamable_http 条目(langchain-mcp-adapters 0.3.2)

- **名字**:`transport: "streamable_http"` + `url` + `headers`。
- **作用**:把"N 个 stdio 子进程"换成"1 个 HTTP 端点";headers 里带 Bearer 票。
- **用法**:agent.py 的 `MCP_SERVERS = {"gateway": {...}}`(agent.py:60 附近),与手动调试路径 `streamablehttp_client`(mcp SDK)同一张票。

### 短时通行证的供给形态(阶段 42 预演)

- **名字**:`scripts/mint-gateway-token.sh`(铸票)+ `run-agent.sh` 启动时 `export GATEWAY_TOKEN=$(...)`。
- **作用**:Agent 进程只拿 60 分钟 token,铸币权(JWT_SECRET_KEY)留在 gateway 家目录;token 不落盘、不进 .env。
- **踩坑实录**:一开始把多行 `python -c` 嵌在 `$(...)` 的双引号里,字典的单引号被 shell 逐字段撕碎(python 收到 `user_data='email': ...` 的 SyntaxError)。解法 = 独立脚本 + `<<'EOF'` 零插值 heredoc——**shell 里传多行代码的唯一稳态**。

### TS 官方 SDK 的最小 client(ts-client/index.ts,锚点件)

- **名字**:`Client` + `StreamableHTTPClientTransport`(@modelcontextprotocol/sdk),`requestInit.headers` 带票。
- **作用**:第二身份;TS 侧几十行完成 connect → listTools → callTool → close。
- **用法**:`cd ts-client && GATEWAY_TOKEN=$(../scripts/mint-gateway-token.sh) npx tsx index.ts`。

## 5. 关键顿悟

- **收敛先于治理**:授权/审计/令牌全是"装在门上的闸"——门没成为唯一入口之前,装闸是自欺。这解释了为什么路线 3 先做 34-36(收敛)再 37-42(治理)。
- **工具名即路由**:Agent 看到的 `filesystem-read-file` 不只是名字,是"网关目录里的路由键"——名字变了,所有引用它的配置(比如审计分级的 TOOL_DATA_CLASS)都得跟着换命名空间。
- **第二身份不是装饰**:单 Agent 的授权矩阵,"Agent 维"是摆设;TS client 进场后,"运维位全权限 / 只读位受限"才有对比实验可做(阶段 38 的越权攻击就打它)。

## 6. 亲手验证

```bash
cd /Users/divh/Downloads/安全评估agent/.scratch/agent-security-learning/starter-agent

# 1. 第二消费者跑一遍(应看到 6 工具 + 一次真实执行)
GATEWAY_TOKEN=$(scripts/mint-gateway-token.sh 2>/dev/null) npx --prefix ts-client tsx ts-client/index.ts

# 2. Agent 一轮(需要你的 Keychain 和已跑的代理/网关/三 server)
printf "用工具列出 workspace 里有哪些文件\n/quit\n" | ./scripts/run-agent.sh
#   应看到:已加载 6 个 MCP 工具(带前缀)→ 工具调用 > filesystem-list-dir(...)
```

**捣乱实验**:把 mint 脚本里的 `expires_in_minutes=60` 改成 0.02(约 1 秒),铸票后 sleep 2 再连网关——应被 401 拒。亲手摸一次"短时"是什么感觉,阶段 42 的 fail-closed 就不难懂了。
