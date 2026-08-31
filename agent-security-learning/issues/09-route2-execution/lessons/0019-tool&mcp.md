好，按我们 6 轮对话从浅到深整理，每段保留问答脉络和关键判断。

---

## 1. 仓库是否用 MCP 服务器模式？

**结论**：是，而且并存**两种** MCP 客户端用法。

**主线（集成进 Agent）**：用 LangChain 官方适配器 `MultiServerMCPClient`，把三个独立 server（filesystem / shell / fetch）合并成一张大工具表，灌给 `create_agent`：

```python
MCP_SERVERS = {
    name: {"command": sys.executable,
           "args": [f"mcp_servers/{name}_server.py"],
           "transport": "stdio"}
    for name in ("filesystem", "shell", "fetch")
}

client = MultiServerMCPClient(MCP_SERVERS)
tools = asyncio.run(client.get_tools())   # 子进程拉起 → 握手 → list_tools
```

**旁路（手动调试）**：留了一份裸的 MCP SDK 客户端，连单个 filesystem server，服务于 CLI 的 `/tools`（列工具清单）和 `/call <name> <json>`（直调一次工具）两条调试指令：

```python
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

FILESYSTEM_SERVER = StdioServerParameters(
    command=sys.executable, args=["mcp_servers/filesystem_server.py"]
)

async def with_mcp(fn):
    async with stdio_client(FILESYSTEM_SERVER) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            return await fn(session)
```

**留旁路的原因**：调试要看 server 本身回什么，不是 Agent 经过 ReAct + 护栏 + 摄像头过滤后的结果。

**为什么是 MCP 而不是函数工具**：
- `mcp_servers/shell_server.py` 的设计是**进程级沙箱边界**——server 进程内部再起 microVM
- filesystem / fetch 的 server 进程也是隔离单元
- MCP 把工具的"执行权"从 Python 同进程里拆出去，安全边界对齐到子进程甚至 microVM 层

---

## 2. MCP 是进程沙箱吗？

**结论**：**不是**。MCP 只是 JSON-RPC 上聊天的协议，没有权限模型、没有系统调用拦截、没有文件系统隔离。

### MCP 本质
```
client                         server
  |   initialize                 |
  | ---------------------------> |
  |   {result: capabilities}     |
  | <--------------------------- |
  |   tools/list                 |
  | ---------------------------> |
  |   {tools: [read_file, …]}    |
  | <--------------------------- |
  |   tools/call {name, args}    |
  | ---------------------------> |
  |   {content: [...]}           |
  | <--------------------------- |
```

server 想干啥就干啥——读 `~/.ssh/id_rsa`、`rm -rf /`、反弹 shell，协议统统不管。

### 它碰巧划出的"进程边界"

`MultiServerMCPClient` 的 stdio 传输确实把每个 server 拉成独立子进程。**但子进程 ≠ 沙箱**：

| 机制 | 隔离强度 | 谁来执行 |
|---|---|---|
| 同进程函数工具 | 共享一切，能改 Agent 状态、改 LLM 响应 | Agent 解释器 |
| **MCP stdio 子进程** | 同一台 OS 同一用户，无任何隔离 | 同一把内核 |
| Linux namespace / cgroup | 独立 PID/mount/net、CPU/内存配额 | 内核 |
| Firecracker microVM | 独立内核，独立设备树，硬件虚拟化 | hypervisor |

MCP stdio 子进程只是普通 process——`ptrace` 能附进去、`kill -9` 能杀崩、文件权限继承宿主用户、能开 socket 出去。

### 这道"沙箱"到底是谁

是这个项目里 `mcp_servers/shell_server.py` **自己实现**的 `run_command`，不是 MCP：

```python
# shell_server.py 内部
async def run_command(args):
    return await microvm.run_once(image, args, timeout=10s)
```

它拉 Firecracker、给一颗独立 CPU/内存、装只读 rootfs、命令退就销毁。microVM 层扛沙箱责任，MCP 只是传输载体。

### 因果链摆正

```
microVM（真隔离）      ← 沙箱边界在这里
  └─ shell_server.py  ← MCP server，有意写得像"另一个进程"
       └─ MCP JSON-RPC over stdio  ← 只是约定，不是边界
            └─ MultiServerMCPClient  ← 只是连接器
                 └─ create_agent     ← LLM 真正看到的那张工具表
```

**别看见"server 进程"就以为是沙箱。客户端进程下面跑的那个 server 进程，跟你在终端里手动 `python x.py` 出来的进程，在内核眼里是完全平等的两条 process。**

---

## 3. LangChain 提供多少种 tool 接入方式、多少种 MCP 实现方式？

### Tool 接入方式（"工具是什么、能力长什么样"）

`BaseTool` 本身只有一条继承线，**变体都在"怎么造它 / 怎么传它"上**：

| # | 方式 | 入口 | 给你的问题 |
|---|---|---|---|
| 1 | `@tool` 装饰器 | `from langchain.tools import tool` | 函数挂装饰器，签注解 + docstring 自动生成 schema |
| 2 | `StructuredTool.from_function` | `from langchain_core.tools import StructuredTool` | 同上但显式构造，可改 args_schema |
| 3 | Pydantic 子类化 `BaseTool` | `class MyTool(BaseTool): async def _arun` | 复杂工具、重写 `_run`/`_arun`、带共享状态 |
| 4 | `tool` 调用（逆向） | `llm.bind_tools([...])` | 不真当工具用，只给模型"看见"签名（前端、路由） |
| 5 | Toolkit（一组相关工具打包） | `class MyToolkit(BaseToolkit): def get_tools` | 一次给一组配套工具 |
| 6 | Runtime Tool / 动态工具 | `InjectedToolArg` / `config.get()` | 工具参数里塞图状态、checkpointer、callback，跑时再注入 |
| 7 | Tool/工具调用协议层 | `tool_choice="any" / "tool"` | 控制模型怎么挑工具 |
| 8 | `ToolsRenderer` / 流式 | `astream_events` + `on_tool_*` | 订阅既有工具的事件 |
| 9 | Server-side / Code-mode | `langchain-code-mode`、`PyInterpreterTool` | 把代码执行环境当"工具"，模型写代码再跑 |
| 10 | `load_tools` / `get_all_tool_names` | `from langchain.agents import load_tools` | 一行字加载社区预制工具包 |

**真正的"工具"类型只有三条类继承线**（`@tool` / `StructuredTool` / `BaseTool`），其余是包装、组织、运行时装配、代码环境当工具。

### MCP 实现方式（"工具住哪里、谁来跑"）

靠 `langchain-mcp-adapters` 这个独立包，跟上面正交。

| # | 接入点 | 走法 |
|---|---|---|
| 1 | `MultiServerMCPClient`（核心入口） | 字典配置多个 server，stdio/HTTP/WS 三种 transport 混跑 |
| 2 | Transport `stdio` | 每个 server 起一个子进程（`StdioServerParameters`） |
| 3 | Transport `http` / `sse` | 连远程 MCP server（`streamable-http`、`sse` 字段） |
| 4 | Transport `websocket` | 新版支持的 WS 通道 |
| 5 | `client.get_tools()` 一次性拿工具表 | 同步/异步版 |
| 6 | `client.get_tool(server, tool)` | 按需取单个工具 |
| 7 | `client.session(name)` 拿原始 session | 想自己 discover/call 时用 |
| 8 | Stateful / 自动重连 | client 配置 `headers`、`ssl_context`，env 读 BEARER_TOKEN |
| 9 | Sampling / Elicitation / Roots 回调 | server 反过来调 LLM、问用户、读 CWD |
| 10 | `langchain-mcp-adapters` ↔ `langgraph-prebuilt` 桥 | MCP 工具直接塞 `create_react_agent` / `create_agent` |

### 两套维度别混

```
工具是什么    → BaseTool 三条线 + Toolkit + 运行时注入
工具住哪      → 本进程 / 子进程(MCP stdio) / 远端(MCP http/sse/ws)
执行面        → 函数 / 微 VM / 远程 API / 浏览器
```

仓库现在踩的脚印：
- 工具定义面：`create_agent(llm, tools, ...)` 吃 `list[BaseTool]`
- 工具来源面：`MultiServerMCPClient` 启动期 `get_tools()` 把 MCP 工具洗成标准 `BaseTool`
- 工具执行面：`shell_server.py` 内部拉 microVM，MCP 不参与

---

## 4. 怎么决定选哪种 tool 和哪种 MCP？

### 一句话判决

- **工具是什么** → 决定 tool 形态
- **工具在哪 / 谁来跑 / 有没有沙箱** → 决定要不要走 MCP
- **两件事独立**，可以组合：MCP 完全可能装的是 `@tool` 风格的能力；本地 `@tool` 也完全可以后接 microVM

### 按"工具是什么"挑 tool 形态

```python
# 1) 一行函数、无状态 ── @tool 装饰器
@tool
def get_weather(city: str) -> str:
    """查某城市当前天气。"""
    return requests.get(...).text

# 2) 函数 + 复杂入参 ── StructuredTool.from_function
class SearchArgs(BaseModel):
    query: str
    top_k: int = 5

search = StructuredTool.from_function(
    func=_search, name="search", args_schema=SearchArgs,
)

# 3) 需要状态 / async / 多分支 ── 子类化 BaseTool
class ShellTool(BaseTool):
    name = "shell"
    description = "在 microVM 里跑 shell"

    async def _arun(self, cmd: str, run_manager, **kwargs) -> str:
        return await self.pool.exec(cmd)   # 共享连接池

# 4) 一组配套工具 ── Toolkit
class GitHubToolkit(BaseToolkit):
    def get_tools(self):
        return [create_issue, list_repos, merge_pr]
```

| 处境 | 选 |
|---|---|
| 一个函数，无状态 | `@tool` |
| 一个函数但参数要 Pydantic 校验 | `StructuredTool.from_function` |
| 需要共享连接、缓存、限流、microVM 客户端、重试 | `BaseTool` 子类 |
| 一组相关操作 | `BaseToolkit` |
| 工具里要读图状态 / store / callback | `InjectedToolArg` / `config.get()` |

### 按"工具住哪"挑 MCP 形态

```python
# A. 本地进程级隔离（仓库现在在走的）
MCP_SERVERS = {
    "filesystem": {"command": sys.executable,
                   "args": ["mcp_servers/filesystem_server.py"],
                   "transport": "stdio"},
}
client = MultiServerMCPClient(MCP_SERVERS)
tools = await client.get_tools()

# B. 跨机器、跨语言
client = MultiServerMCPClient({
    "weather": {"url": "https://mcp.weather.com/sse", "transport": "sse"},
    "docs":    {"url": "https://mcp.docs.com/mcp",   "transport": "streamable-http",
                "headers": {"Authorization": f"Bearer {TOKEN}"}},
})

# C. 边发现边调 / 取一个工具 / 保留调试通道
session = await client.session("filesystem")
await session.list_tools()
await session.call_tool("read_file", {"path": "/x"})

# 或者
single_tool = await client.get_tool("filesystem", "read_file")
```

| 处境 | 选 |
|---|---|
| 把工具丢出本进程统一调度 | `MultiServerMCPClient` + 字典 |
| Server 都本机、各自一个进程、stdout 通信 | `transport: "stdio"` |
| Server 是别人部署的 HTTP 服务 | `transport: "sse"` / `"streamable-http"` |
| Server 在云上、想保住长连接 | `transport: "websocket"` |
| 只想要其中一把工具 | `get_tool(server, name)` |
| 想绕开 Adapter 自己聊协议 | `client.session(name)` |
| Server 想回头调 LLM / 问用户 / 读客户端 CWD | 装 sampling/elicitation/roots hooks |

### 最常碰到的 9 个问题速答

| 想…… | 走法 |
|---|---|
| 写几个轻工具喂给 Agent | `@tool` + `create_agent(llm, [t1, t2])` |
| 工具需要共享客户端、状态、限流 | `class XTool(BaseTool)` |
| 参数要 Pydantic 校验、or 想改 schema | `StructuredTool.from_function` |
| 一组配套工具（GitHub / SQL / Notion） | `BaseToolkit` |
| **本机直接拉 microVM 跑不可信命令** | `BaseTool` 子类直连 microVM SDK（不必硬套 MCP） |
| **让 microVM 的进程化边界跟工具清单解耦** | MCP server 子进程内部用 microVM，外面 `MultiServerMCPClient` |
| 工具是别人用 Python / TS 写的现成服务 | `MultiServerMCPClient` + `streamable-http` |
| 我想自己排查 server 暴露了什么 | `client.session(name).list_tools()` |
| 工具里要读对话历史 / 长期记忆 | `InjectedToolArg` / `config.get()` |

### 三条铁律

1. **MCP 不是沙箱**。只负责把能力挪到别的进程/机器跑，安全由 server 内部实现（microVM、namespace、ACL、纯函数）。
2. **tool 形态跟 MCP 正交**。一份代码可以是 `@tool`、也可以包成 MCP server，工具定义和执行位置互不绑。
3. **`create_agent` / `create_react_agent` 只吃 `BaseTool` 列表**。MCP 适配器的活干到 `get_tools()` 就完事了，吐出来已是标准 `BaseTool`。

### 这个项目拍板的方式

- 工具形态 → `BaseTool` 子类化，因为每个 server 都有共享资源（microVM 池、filesys 句柄、HTTP client）
- 接入方式 → `MultiServerMCPClient`，因为三个 server 必须能**单独升级/重启/替换**（shell 挂了不连带 filesystem）
- 执行面 → server 自己扛（microVM、容器、远程服务都行）

**不要为"用 MCP 而用 MCP"**——本进程一个 `@tool` 函数能解决的，不要硬塞 stdio 子进程；反过来，已经有别的团队/别的语言的服务，直接 HTTP/MCP 才是正解。