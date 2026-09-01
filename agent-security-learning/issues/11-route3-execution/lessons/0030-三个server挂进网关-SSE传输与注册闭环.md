# 0030 - 三个 server 挂进网关:SSE 传输与注册闭环

## 1. 三问(这一阶段是干嘛的)

**位置感**:

```
✅ 34 网关上岗 → ▶️ 35 三server挂网关(你在这里) → 36 Agent改走网关 → 37 OpenFGA建模 → ...
```

**这一阶段是干嘛的?** 让网关"认识"我们的三个工具 server——把 filesystem/shell/fetch 以 HTTP 形态挂到端口上,在网关注册,最后**在网关的工具列表里看到 6 个工具**。

**什么需求逼我们这么设计?** 阶段 34 的网关是个空前台:它还不知道这栋楼有哪些房间。MCP 网关不代管进程(研究结论 A1:上游必须以 URL 注册),所以每个 server 得自己"开门营业"(挂 HTTP 端口),再拿着 URL 到前台登记。登记之后,前台才可能替所有访客(Agent)安排一切——阶段 36 拔直连的前提。

**它解决了什么麻烦?** 完成了"server 直连"到"可经网关"的形态准备。此刻两种形态并存:agent 还在用 stdio 直连(默认模式),网关走 SSE——拔直连是下一阶段的事,一次只动一处。

## 2. 全链路一览

```
 ┌──────────┐  stdio(老形态,36 拔除)   ┌─────────────────┐
 │ 起步 Agent│ ──────────────────────→ │ 三个 server 进程   │
 │          │                          │ filesystem :8001 │
 │          │  (阶段 36 起改走下面这条)   │ shell      :8002 │
 │          │                          │ fetch      :8003 │
 │          │                          └────────┬────────┘
 │          │            ① GET /sse 开长驻事件流  │
 │          │            ② POST /messages/…收发  │
 │          │                          ┌────────┴────────┐
 └──────────┘                 ┌────────→│ 网关 ContextForge │
                              │   4444   │ (已登记三家+6工具) │
                    浏览器看板  └────────→└─────────────────┘
```

## 3. 跟着数据走:一次"注册"的完整握手

以 `filesystem` 注册进网关为例,看数据怎么流(带一个捣乱插曲):

1. **server 先开门**:`MCP_TRANSPORT=http` 启动 → FastMCP 以 SSE 传输监听 8001。任何人 `GET /sse` 会立刻收到一条 `event: endpoint` + `data: /messages/?session_id=3bb7…`——这是 SSE 协议的"见面礼":给你一条带会话号的回传地址。
2. **网关登记**:`POST /admin/gateways`,body 里只有三样:名字、URL(`http://127.0.0.1:8001/sse`)、描述。
3. **网关亲自去握手**(这步最关键):收到登记请求后,网关自己作为 MCP 客户端连到那个 URL,走完整的 initialize → tools/list,把工具清单抄回来入库。所以我们注册完立刻 `GET /tools` 就能看到 `filesystem-read-file` 等 3 个工具——**登记即盘点**。
4. **捣乱插曲(实测踩坑)**:我们最初用 streamable-http 传输注册,网关握手的第一步是 `GET /mcp` 打开长驻事件流,而我们的 server 处于 stateless 模式,收到 GET 就把会话终结掉(server 日志里三连 `Terminating session: None`),网关傻等 30 秒超时。换 SSE(网关官方桥接工具同款)一次通过。
5. **工具名变了**:注册后网关里的工具叫 `filesystem-read-file` 而不是 `read_file`——网关用"server 名-工具名"加前缀做命名空间,两个 server 即使有同名工具也不会撞车。

## 4. 新技术点四要素

### FastMCP 的 transport 参数(官方 mcp SDK 1.29)

- **名字**:`mcp.run(transport="sse" | "streamable-http" | "stdio")`,构造器可配 `host/port`。
- **作用**:同一个 server 代码,换一种"接客方式"。stdio=被当子进程拉起;SSE=挂端口,先给会话再收消息(HTTP+SSE,2024-11 版 MCP 协议);streamable-http=单端点流式(2025-03 版)。
- **用法**:本项目 `mcp_servers/*_server.py` 底部,`MCP_TRANSPORT=http` 环境变量切换,默认仍是 stdio。

### ContextForge 的注册 API 与 Bearer 认证

- **名字**:`POST /admin/gateways`(登记上游)、`GET /tools`(网关工具清单),认证 `Authorization: Bearer <JWT>`。
- **作用/参数**:body 三件套 `{"name","url","description"}`;JWT 由 `JWT_SECRET_KEY` 签发。
- **用法**:`scripts/` 里的注册命令;token 用网关自己的 `create_jwt_token` 函数铸造(60 分钟有效)。

### JWT 的 teams 旁路规则(踩坑核心)

- **名字**:`normalize_token_teams`(auth_context.py)。
- **作用**:token 里的 teams claim 决定权限边界——**键缺席=公开级;`[]`=公开级;只有 `teams: null` 且带 `is_admin` 才是管理员旁路**。空列表不是"什么都没有",是"明示只看公开内容"。
- **参数**:`create_jwt_token(..., teams=None)` 显式序列化 `"teams": null`。

## 5. 关键顿悟

- **登记即盘点**:网关注册上游时会亲自做一次 MCP 握手抄工具清单——所以"工具出现在网关列表"不是名字登记,是真握手成功的证明;反过来,server 挂了网关立刻知道(阶段 44 验收会用到)。
- **SSRF 防护是默认姿态**:注册 `http://127.0.0.1:*` 被网关拒了("Gateway URL contains localhost address which is blocked by SSRF protection")——防的是"毒注册把网关当跳板打内网",和路线 2 microsandbox 拒私网同一个思想。本地教学用 `SSRF_ALLOW_LOCALHOST=true` 只放行回环,RFC1918 私网和云元数据照拒。
- **HTTP 里也有两套传输协议口味**:streamable-http(新,单端点)与 HTTP+SSE(旧但普及)。选型的现实依据不是"谁新用谁",而是"对接的另一端实测吃哪个"——我们用 server 日志里的 `GET /mcp` + `Terminating session` 十分钟定位了协议不合,这比查文档快。

## 6. 亲手验证

```bash
# 1. 看三家 server 的"见面礼"(各不相同的是会话号,相同的是 event: endpoint)
curl -s --max-time 3 http://127.0.0.1:8001/sse | head -2
curl -s --max-time 3 http://127.0.0.1:8002/sse | head -2

# 2. 浏览器打开网关看板 http://127.0.0.1:4444 → Gateways / Tools 页
#    应看到 filesystem/shell/fetch 三个上游 + 6 个带前缀的工具

# 3. (可选)自己起 server:先杀掉 agent 代跑的,再用自己的终端
lsof -ti:8001,8002,8003 | xargs kill
/Users/divh/Downloads/安全评估agent/.scratch/agent-security-learning/starter-agent/scripts/run-mcp-servers.sh
```

**捣乱实验**:`kill` 掉 8001 的 filesystem 进程,再看网关 Gateways 页——filesystem 应显示离线/active=false(登记还在,心跳断了)。想恢复再跑一次 `run-mcp-servers.sh` 即可;这也是阶段 44"网关收敛"验收的预演:网关时刻知道上游死活。
