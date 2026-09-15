# 0019 shell 工具进 microVM —— 知识卡片

### 换执行面[自造],不动接口(transparent execution-surface swap)

是什么:指把工具命令真正运行的那一层整体更换——这层叫执行面 [自造](代码在哪执行:宿主机进程、容器或虚拟机),且对模型暴露的工具签名、调用协议、返回格式一字不改。改造前的链路:模型发起命令调用,命令经 MCP(Model Context Protocol,把工具暴露给 Agent 的标准协议)传到本机 server,server 再用 subprocess(Python 标准库的子进程模块)把命令直接跑在宿主机上。改造后在链路中间加一步:server 先用 `Sandbox.create()`(microsandbox SDK 拉起虚拟机的入口)开一台一次性 microVM(micro virtual machine,微型虚拟机),命令在 VM 里执行完、输出原样送回。这种微型虚拟机靠硬件虚拟化、只带极简设备模型,与共享宿主内核的容器不同——每个工作负载都被一道独立的硬件级虚拟化屏障包住,这是 Firecracker 等一线项目给 microVM 的标准定位。类比"换发动机不换方向盘"(自创比喻,仅助记):司机(模型)的驾驶动作完全不变。

解决什么问题:提示注入(prompt injection,OWASP LLM01:2025 宽口径——凡用户输入使模型行为或输出偏离预期即算,直接写进对话与藏在内容里都算)拦不完,防御升级就不能指望模型"自觉不乱执行"。本卡场景属于后者:把恶意指令塞进模型读到的内容里、诱骗模型替他执行。MCP 官方文档也把防线放在协议外——工具调用 SHOULD 始终保留一个能拒绝执行的人类兜底,而不是指望模型自己扛。接口不动,加固层就能独自变强:以前攻击者拿到命令执行权等于拿到宿主机的 shell;现在等于拿到一台马上销毁的空白 Linux 小虚拟机。"得手"因此变得不值钱。而"得手也没用"靠的是一次性删掉持久化——实测第一次调用种下的后门文件,第二次调用拿到的是全新 VM,后门已随旧 VM 一起销毁(细节见"ephemeral 用完即焚"那张卡)。

我们的办法:把最危险的任意 shell 命令工具(即 microsandbox 官方所称的 untrusted workloads、不可信工作负载)从宿主机 subprocess 整体搬进一次性 microVM,对外签名一字未动,改动净增约 10 行。这套"每次调用开一台全新 VM"的架构成立前提是冷启动够快——microsandbox 官方声称平均开机不到 100 毫秒(beta 阶段自测数据),实测两次调用含两次 VM 开机加销毁共约 1.2 秒。

### FastMCP 异步工具(async tool function)

是什么:FastMCP 的异步(async)工具是用 `async def` 函数加 `@mcp.tool()` 装饰器写成的 MCP server 工具,FastMCP 则是把普通 Python 函数直接变成 MCP 工具的框架(分两支——官方 Python SDK 内置的 v1 与社区现役的 v2,文档在 gofastmcp.com,细节以实测版本为准)。函数定义的方式决定工具在模型客户端眼中的样子:docstring(函数文档字符串)变成工具描述、类型注解变成 inputSchema(描述入参的 JSON schema),所以不支持 `*args`/`**kwargs` 这类无固定签名的写法。调用时,FastMCP 在自己的事件循环(event loop,异步程序里调度所有等待任务的单线程调度器)里 await 这个函数。例子:写成 `async def run_command(command: str) -> str` 再挂上装饰器,模型侧看到的就是"传入一个字符串命令、返回一段字符串输出"的工具。配套细节:沙箱名带随机后缀防撞名(形如 `shell-` 接 8 位随机十六进制,如 `f"shell-{uuid4().hex[:8]}"`)——microsandbox 运行时按名字管理沙箱状态,两次调用若重名会互相覆盖,这是沙箱层的命名问题。(MCP 协议层也有类似的唯一性要求:工具名 SHOULD 在 server 内唯一,但那是另一件事。)

解决什么问题:microsandbox SDK 全异步(`Sandbox.create`、`sb.shell` 都必须 await,即异步等待结果)。MCP 工具函数若是同步的(如早先的 `subprocess.run`,发起后一直阻塞到命令结束)也并非不能用——FastMCP 会自动把同步工具丢进线程池(threadpool)执行,不需要用户手写任何同步桥接。但 async 工具省掉这层线程池调度的开销,且与全异步 SDK 在同一个事件循环内自然对齐;而对 MCP 客户端(Agent)来说毫无区别——同步版和异步版都是"发请求、等结果"。

我们的办法:shell 工具的 MCP server 用 async 工具函数包住 microsandbox SDK 的调用,命令执行发生在函数体内部的一次性 microVM 里。实测该写法直接工作,全程没有引入任何线程桥接代码。
