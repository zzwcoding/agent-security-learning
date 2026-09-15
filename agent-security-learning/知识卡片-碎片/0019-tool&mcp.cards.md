# 0019 tool & mcp —— 知识卡片

### MultiServerMCPClient(LangChain 的多 server MCP 适配器)

是什么:MultiServerMCPClient 是 LangChain(一套流行的 Python Agent 开发框架)官方适配器包(langchain-mcp-adapters)提供的核心入口类:用一份字典配置同时连接多个 MCP(Model Context Protocol,把工具暴露给 Agent 的标准协议)server,再把各 server 的工具合并成一张统一的大工具表。配置项里最关键的是 transport(传输方式):`stdio` 表示"每个 server 在本机拉成一个子进程、经标准输入输出通信",远程接入的键值官方写作 `http` 与 `sse`(不同版本命名有出入,以实测版本为准),可混跑。例子:配置 `{"shell": {"command": <python 解释器>, "args": [<server 脚本>], "transport": "stdio"}}`。启动期 `client.get_tools()` 会连接各 server、完成握手、列出工具清单,并把 MCP 工具"洗"成 LangChain 标准的 BaseTool(所有工具的统一基类);注意会话不是启动期建好长期复用——默认每次工具调用都各起一个新的 MCP ClientSession(会话用完即弃)。工具清单可按 server 过滤(`get_tools(server_name=...)`)、也能经 `client.session(名字)` 这个异步上下文管理器(`async with client.session("x") as s`)自己跟协议对话(API 细节以实测版本为准)。

解决什么问题:把"工具的执行权"从 Agent 的 Python 同进程里拆出去,让每个工具 server 成为可单独升级、重启、替换的单元——一个 server 崩了不连带其他;同时把"工具住在别的进程甚至别的机器"这个事实对 Agent 代码完全屏蔽。多 server 工具重名时,适配器可用 `tool_name_prefix=True` 给工具名加 server 前缀(MCP 规范在重名场景也建议用 server 标识做前缀消歧)——与"FastMCP 异步工具"卡里的随机后缀是同一问题在两个层级的解法。Agent 看到的与 server 原始返回也可能不一样:开启 `handle_tool_errors=True` 时,工具执行错误会被转成带 `status="error"` 的 ToolMessage 让模型自纠而不是崩掉整轮,其余错误不被吞掉。

我们的办法:用一份字典把三个工具 server(分别管文件读写 / shell 命令 / 网页抓取)合成一张大工具表灌给 Agent。另留一份裸 MCP SDK 客户端作旁路,直连单个 server、直接发协议消息看原始返回——调试时要看的是 server 真实回什么,而不是 Agent 经过推理与错误包装管线后呈现的东西,两者可能不一样。

### MCP 不是沙箱(MCP is a protocol, not a sandbox)

是什么:MCP(Model Context Protocol)本质只是一套 JSON-RPC(基于 JSON 文本的远程调用消息格式)会话约定:客户端先 initialize 握手,再 tools/list 拿工具清单,然后 tools/call 发 `{"name": "read_file", "arguments": {...}}` 这样的调用、收回一段 content。它是协议不是隔离机制——对 server 进程没有系统级权限约束、没有进程或文件系统隔离(注意:MCP 确有一套 OAuth 2.1 授权规范,但那管的是"谁能连上远程 HTTP server",不是"server 进程能在宿主机上动什么")。把"MCP server 进程"当成沙箱,是一个常见且危险的误判。

怎么得手:stdio 传输确实把每个 server 拉成独立子进程,但子进程不等于沙箱——它与宿主机同一操作系统、同一用户、同一把内核(在隔离强度阶梯 [自造:同进程→同用户子进程→namespace/cgroup→microVM,由弱到强;详见 0018 卡「沙箱隔离强度阶梯」] 里只是最底部那一档)。MCP 官方安全最佳实践几乎原话承认这点:本地 MCP server 是下载后在客户端同一台机器上执行的二进制,没有沙箱与同意机制时,"攻击者能以 MCP 客户端的权限执行任意命令"。这是与具体实现无关的通用结论:这样的子进程可被 ptrace(调试器附着并操控别的进程的系统调用)附着、也能被信号杀崩。它的文件权限原样继承宿主用户,还能自由开网络连接——在内核眼里,它和你手动用 python 起一个脚本的进程完全平等。server 想偷你的 SSH 私钥还是删库,协议一概不管(官方威胁示例就是一个恶意包执行后把 `~/.ssh/id_rsa` POST 到攻击者服务器);若把安全押在"MCP 已经拆了进程"上,注入得手的攻击者拿到的就是宿主用户的全套权限。

我们的对策:沙箱责任不由协议层承担——MCP 官方的缓解清单也是同一方向:警告用户 server 与客户端同权限,把 server 放进最小默认权限的沙箱环境里跑,或用容器等平台级隔离技术。我们的落法是 shell 工具的 MCP server 内部用 microVM(独立内核的微型虚拟机)跑不可信命令,MCP 只当传输载体——因果链要摆正:真隔离在 microVM 层,server 进程只是"另一个进程",JSON-RPC 只是约定。

### 工具形态与执行位置正交[自造](tool form ⊥ execution location)

是什么:指 Agent 工具体系里两个互相独立的设计维度——"工具是什么"(定义形态)与"工具住哪、谁来跑"(接入与执行位置)。"正交 [自造]"是借数学的说法(经验总结,官方无此框架):两者互不绑定、可自由组合——一个查天气函数,既能 `@tool` 后直接喂给 create_agent(LangChain 的 Agent 构造函数),也能原样包成 MCP server 挂到远程。LangChain(一套流行的 Python Agent 开发框架)里函数形态工具常见路径有三条,一是 @tool 装饰器:类型注解和 docstring 自动生成 schema,进阶可用 `args_schema` 显式指定入参结构——值可以是 Pydantic 模型(Python 的数据校验库),也可以是 JSON Schema(用 JSON 描述数据结构的规范)。二是 `StructuredTool.from_function`(显式构造,适合程序化拼装工具)。三是 BaseTool 子类(能持有连接池、缓存等共享状态,重写同步/异步执行逻辑)。此外官方还有不依赖函数的 schema-only 工具形态,所以"三条"是常见路径而非全部。

解决什么问题:选型时避免两个极端——"为用 MCP 而用 MCP"(本进程一个函数能解决的,硬塞一个 stdio 子进程)和"该拆不拆"(别的团队、别的语言写好的现成服务,直接走 MCP 的 HTTP 接入才是正解)。按处境挑形态:无状态单函数用 @tool;入参复杂要校验,用 @tool 挂 `args_schema` 或 StructuredTool;要共享客户端、限流、连接池用 BaseTool 子类;一组配套操作用 Toolkit。Toolkit(官方定义为"一组为完成特定任务配套使用的工具",统一出口 `get_tools()`)与运行时注入参数(`ToolRuntime`)都只是包装与装配,不改变形态选择。后者的安全细节:注入的图状态等不会出现在发给模型的 schema 里,对模型不可见。

我们的办法:工具形态选 BaseTool 子类(每个工具 server 都持有共享资源,如 microVM 连接),接入方式选 MultiServerMCPClient(各 server 必须能单独替换)。执行面则由各 server 自己扛——可以是 microVM 这类虚拟机,也可以是容器或远程服务。
