# 阶段 5:shell + fetch 两个 server 补齐

## 一、三问(阶段动机)

**这一阶段是干嘛的**:复用阶段 3 的 FastMCP 模式,再写两个 MCP server——`shell`(任意命令)和 `fetch`(HTTP GET/POST),三 server 聚合成一张 6 工具的工具表。

**因为什么需求需要这么设计**:规格明确"shell 任意命令、fetch 任意 URL,故意裸奔"。为什么故意?因为这套学习项目的主线是防御——你需要一个**已知裸奔的基线**,后面的护栏、容器、网关才有明确的靶子。fetch 自己手写而不用官方 server,因为官方只有 GET,规格要求 GET+POST(POST 是数据外泄的通道,攻防双方都关心)。

**解决了什么问题**:攻击面完整了。文件读写(数据窃取/篡改)+ 任意命令执行(主机控制)+ 任意网络请求(外泄/SSRF)——这是 Agent 安全事故的三条主通道,现在每条都有一个可观察、可实验的工具。

## 二、全链路一览

```
你: "统计 notes.txt 字符数,再 GET example.com"
   │
   ▼
ReAct 循环(阶段 4 那张图,不变)
   │  区别只在工具表:6 个工具,分属 3 个 server 进程
   ▼
MultiServerMCPClient(MCP_SERVERS 三条目)
   ├─► filesystem 子进程 ── 限 workspace,有 _resolve 守卫
   ├─► shell 子进程 ─────── subprocess shell=True,无限制 ←┐
   └─► fetch 子进程 ─────── httpx 直连任意 URL,无限制   ←┤ 故意裸奔
   │                                                      │
   ▼                                                      ▼
工具结果回喂模型 …… 循环                          攻击面 = 这两个工具的输入
```

## 三、跟着数据走 3 步

1. **聚合**:启动日志 `已加载 6 个 MCP 工具: ['read_file','write_file','list_dir','run_command','http_get','http_post']`。`MultiServerMCPClient` 对 `MCP_SERVERS` 三个条目各拉起子进程、握手、list_tools,合并成一张表给 `create_agent`。**加 server = 字典加一行**,这就是 MCP 聚合的全部成本。
2. **一次触发三工具**:实测一句话让模型并行决策出三个调用:`list_dir({"path":"."})`、`run_command({"command":"wc -c notes.txt"})`、`http_get({"url":"http://example.com"})`——决策权完全在模型,工具之间它自己排布。
3. **POST 验证**:`http_post https://httpbin.org/post body=hello` → httpbin 回显 `"data": "hello"`。POST 通道打通意味着:Agent 能把任何东西发送到任何地方——记住这条,路线 1 的 egress 控制就堵它。

**实测翻车(保留作教具)**:`run_command` 里 `wc -c notes.txt` 报"文件不存在"——shell server 的 cwd 是 agent 根目录,而 filesystem 工具的根是 `workspace/`。两个工具对"同一个文件"的视图不一致,模型被绕糊涂了。**基线里不同工具的隔离边界不统一**,这本身就是路线 1 要解决的问题,现在不修。

## 四、新技术点四要素

### subprocess(标准库,进程执行)

- **名字**:`subprocess.run`,Python 标准库进程管理
- **作用**:在 Python 里执行外部命令。和 `os.system` 的区别:能拿 stdout/stderr/退出码,能设超时
- **参数**:`subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=30)`——`shell=True` 把整串交给 shell 解析(支持管道,但**注入面也最大**:命令拼接=命令注入);`timeout` 防挂死
- **用法**:挂载点 `mcp_servers/shell_server.py:14`。安全项目里看到 `shell=True` + 外部输入,就要条件反射:这是 RCE 入口

### httpx(Python HTTP 客户端)

- **名字**:httpx v0.28.1,生态归属:现代 Python HTTP 客户端(requests 的 async 时代继任者)
- **作用**:发 HTTP 请求;和 requests 的区别:同时支持同步/异步、HTTP/2
- **参数**:`httpx.get/post(url, content=, timeout=, follow_redirects=)`——`timeout` 必须显式给(默认永不超时,agent 会被挂死);`follow_redirects=True` 让重定向透明(**SSRF 绕过点**:你以为请求的是 A,302 一跳到内网 B)
- **用法**:挂载点 `mcp_servers/fetch_server.py`;响应截断 4000 字符防超长内容灌爆模型上下文

## 五、关键顿悟

- **裸奔是设计出来的,不是偷懒**:每个工具注释里都写明"故意"二字。安全学习的第一步是有一个你完全了解攻击面的靶子——不安全的系统要清清楚楚地不安全。
- **工具边界不统一=逻辑漏洞温床**:filesystem 限 workspace、shell 却不限,同一文件两种视图。防御不是给单个工具加锁,而是统一所有工具看到的世界。
- **聚合成本≈零意味着攻击面扩张也≈零成本**:`MCP_SERVERS` 加一行就多一个能力域。以后接第三方 MCP server 时同样一行——信任决策必须跟上这个速度,这正是 MCP 网关存在的理由(issues/05 已选型)。
