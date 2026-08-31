# 0019 shell 工具进 microVM(阶段 22)

## 三问(阶段动机)

**终极目标**:Agent 就算被注入完全劫持,也伤不到宿主机。

路线图:

```
✅ 阶段21:microVM 最小闭环跑通
👈 阶段22:shell 工具搬进 microVM(攻击者的手被关进玻璃房)
⬜ 阶段23:fetch 进 microVM + 出网白名单
⬜ 阶段24:Docker vs microVM 逃逸对比
⬜ 阶段26-27:凭证代理
```

**这一阶段是干嘛的?** 把 Agent 最危险的那件武器——`run_command`(能执行任意 shell 命令)——从宿主机手里夺下来,放进一次性 microVM。

**什么需求逼的?** 路线 1 反复证明:`run_command` 是注入得手后的第一站(战利品之一就是"让 run_command 执行非预期命令")。护栏拦不住全部注入,那就让"得手"变得不值钱:命令照样执行,但执行的地方不是你家。

**解决了什么麻烦?** 改动极小(一个文件,净增约 10 行),威胁模型却整个变了:以前攻击者拿到 run_command = 拿到你 Mac 的 shell;现在 = 拿到一台 1 秒后就要被销毁的空白 Linux 小虚拟机。

## 全链路一览

改造前(路线 1 形态):

```
模型说"调用 run_command('cat ~/.ssh/id_rsa')"
   → MCP stdio 传给 shell_server
   → subprocess.run(宿主机!)   ← 直接在你 Mac 上跑,完蛋
```

改造后(阶段 22):

```
模型说"调用 run_command('某命令')"
   → MCP stdio 传给 shell_server(还是宿主机上一个 Python 进程)
   → Sandbox.create() 拉起一台一次性 microVM   ← 多出来的就是这层
   → sb.shell(命令) 在 VM 里执行
   → 输出包成 ExecOutput 送回 → 经 MCP 回给模型
   → async with 结束,VM 连锅端掉
```

注意:**MCP 的接口、工具签名、返回格式一个字没变**。模型和 Agent 主程序完全无感——这就是"在工具内部换执行面"的好处:防御升级不需要模型配合。

## 跟着数据走:一次"攻击者"调用

验证脚本走真实 MCP 协议调了两次 `run_command`:

1. **第一次调用**:`uname -srm; ls /Users; touch /tmp/pwned; ls /tmp`
   - shell_server 收到字符串 → `Sandbox.create(name="shell-a1b2c3d4", image="python:3.12", ephemeral=True)` → 一台新 VM 开机(约 0.5 秒)
   - `sb.shell(...)` 把命令交给 VM 内的 /bin/sh → 返回 `Linux 6.12.99 aarch64`、`/Users 不存在`、`pwned` 写入成功
   - `async with` 退出 → VM 销毁
2. **第二次调用**:`ls /tmp` → **又一台全新 VM**,/tmp 空空如也,`pwned` 没了

第二条就是"一次性"的实证:攻击者第一次调用种的后门文件,第二次调用时已经跟着第一台 VM 一起火化了。他想搞持久化?没有"下一次",每次开机都是一张白纸。

## 新技术点:FastMCP 的异步工具

- **名字**:FastMCP 异步工具函数(`async def` + `@mcp.tool()`)
- **作用**:MCP server 的工具函数可以是 async 的,FastMCP 会在自己的事件循环里 await 它。microsandbox SDK 全异步(`Sandbox.create`、`sb.shell` 都要 await),两者正好对上——不需要任何线程/同步桥接。
- **参数/用法**:就是普通 async 函数加装饰器,签名即工具 schema(`command: str -> str`)。本项目用在 `mcp_servers/shell_server.py:23`。
- **对照**:阶段 5 的 `subprocess.run` 是同步阻塞;现在 `await sb.shell()` 是异步等待——对 MCP 客户端(Agent)来说,都是"发请求等结果",没区别。

另一个细节:`name=f"shell-{uuid4().hex[:8]}"`——每台 VM 起个带随机后缀的名字,防止两次调用撞名(Sandbox 按名字管理状态)。

## 关键顿悟

- **换执行面,不动接口**:MCP 工具签名原封不动,内部实现从 subprocess 换成 microVM——安全架构升级可以对模型完全透明。好的纵深防御就该长这样:每层自己变强,不要求别的层配合。
- **"一次性"比"加固"便宜**:与其给一台长期运行的环境堆加固(补不完的洞),不如让环境根本没有"长期"——ephemeral VM 把持久化威胁整个删掉了。
- **性能账**:实测两次调用(含两次 VM 冷启动+销毁)共 1.2 秒。秒级以下的 microVM 冷启动,是"一次一 VM"这种奢侈架构能成立的前提。
