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

## 7. 延伸讨论:第二消费者的安防对照与"一把 key"之问(2026-09-03 复习期增补)

> 来源:复习期对本文档的问答整理,已对照原文核实;讹误已修正。

### 7.1 配置在 ts-client 身上的安全措施(实配五条)

| 措施 | 实质 |
|---|---|
| 强制走同一扇门 | 只知 `127.0.0.1:4444/mcp`,不知三 server 端口——拓扑知识从客户端收走 |
| Bearer 短时票 | `mint-gateway-token.sh` 铸 60 分钟票,`requestInit.headers` 携带 |
| 票不落盘 | 命令行 `GATEWAY_TOKEN=$(...)` 注入;铸币权(JWT_SECRET_KEY)留网关家目录 |
| 工具名即路由键 | 只见网关目录里的带前缀名,不见 server 原生名 |
| 回路信任 | 网关监听 127.0.0.1,未上 TLS(默认信回环,生产须补) |

**纠偏**:ts-client 是纯 MCP client(connect→listTools→callTool→close),**不调 LLM、不需要真 key**——"它怎么拿 LLM key"不是文档遗漏,是这个客户端的职责边界本来就没有 LLM。

它在体系里的角色(比实配更重要):① 让"Agent 维"授权矩阵从摆设变可实验(阶段 38 越权攻击的对照组);② 证明"门真的是唯一入口";③ 让"命名空间一变全员跟改"的耦合显形。

### 7.2 两个消费者的安防为什么"一样"——是刻意的

36 阶段两者实配完全相同(同门/同票/同注入方式),因为本阶段只做**收敛**。**差异不写死在客户端**:后续阶段(37/38/42)的差别全部发生在网关侧——token claims 里的身份 + OpenFGA 元组决定"谁能执行什么",客户端 SDK 零差异化。新增一类消费者 = 策略库加一行映射,不改任何客户端。

### 7.3 "JS 前端一把 key 调 LLM" 和这里的区别——不在同一纬度

| 维度 | LLM API key | MCP token |
|---|---|---|
| 被调方能力 | 只产文本 | 动你的文件/Shell/出网 |
| 凭证功能 | 计费+配额 | 身份+权限+审计 |
| 泄漏半径 | 钱包+对话历史 | 你机器上的 sudo |
| 需要细粒度授权/审计/可撤销 | 不需要 | 必须 |

- 判定原则:**被调方会不会动"调用方环境之外"的副作用**?不会(纯文本生成)→ 一把 key 够用;会(动文件/Shell/外部写)→ 短时票+网关+策略的复杂度不可省略。
- 一句话:LLM 的"key 一把走"成立是因为它的能力边界天然压低风险;MCP 把"决策→执行"打通后,**能力 = 风险**,复杂度是结构性的。

### 7.4 生产外延(未实测,仅方向——按"按实际行为写"纪律标注)

mTLS/SPIFFE 工作负载身份替代环境变量传票、中心策略库(OpenFGA/OPA/Cedar)按 principal × tool 声明式配置、按身份的速率配额、kill switch 全员熔断。这些是方向性常识,本项目未验证。
