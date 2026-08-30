# 0018 microsandbox 最小闭环(阶段 21)

## 三问(阶段动机)

**终极目标**:把 Agent 改造成"就算被提示注入完全劫持,也伤不到宿主机"的形态。

路线图(✅=已完成,👈=你在这里):

```
✅ 路线1:守门员(注入扫描/护栏/容器加固)——结论:注入防不住是必然
👈 阶段21:microVM 这块砖长什么样?先跑通最小闭环
⬜ 阶段22:shell 工具搬进 microVM(攻击者的手被关进玻璃房)
⬜ 阶段23:fetch 进 microVM + 出网白名单(堵住密钥外泄)
⬜ 阶段24:Docker vs microVM 同一段逃逸代码对比
⬜ 阶段26-27:凭证代理(真 key 连 Agent 进程都不进)
```

**这一阶段是干嘛的?** 不动 Agent 的一行代码,只做一件事:证明 microsandbox 这个工具在我们这台 Mac 上能用、好用——装得上、起得来、命令跑得进去、结果拿得出来。

**什么需求逼的?** 路线 1 的教训:三层护栏全部就位,注入攻击仍然能漏进来(分类器有盲区、拆行能绕)。那就换思路——不指望拦住注入,而是让注入得手之后,攻击者拿到的 `run_command` 工具只能在一台一次性的、用完就烧掉的小虚拟机里折腾。这台小虚拟机就是 microVM,阶段 21 先把它跑起来看看。

**解决了什么麻烦?** 它解决了"隔离"和"能用"的矛盾:Docker 容器快但和宿主机共享内核(一个内核漏洞就可能穿墙),真虚拟机隔离好但开机要几分钟。microVM 两头都占:有自己独立的 Linux 内核(穿墙要打穿硬件虚拟化层),冷启动却是秒级。

## 全链路一览

```
你敲的命令 / Agent 的工具调用
   │
   ▼
Python SDK(Sandbox.create / sb.shell)   ← 你写的代码,管家
   │
   ▼
libkrun(Rust 写的虚拟化库)             ← 包工头,负责搭虚拟机
   │
   ▼
Hypervisor.framework(macOS 自带)       ← 芯片级虚拟化接口,苹果官方提供
   │
   ▼
microVM:独立 Linux 6.12 内核 + 独立文件系统 + 独立网络
```

一句话版:你的 Python 代码当管家,libkrun 当包工头,macOS 的 Hypervisor.framework 是通往 CPU 虚拟化能力的官方大门,门后是一台五脏俱全但用完即焚的小 Linux 机器。

## 跟着数据走:一条命令的旅程

以探针脚本里的 `sb.shell("uname -srm; ...")` 为例:

1. **你给出字符串**:`"uname -srm; hostname; ls /Users ..."` —— 在宿主机这边,它只是内存里一段文本,什么都没发生。
2. **SDK 打包发进 VM**:microsandbox 的 SDK 是"嵌入式"的——没有守护进程,`Sandbox.create()` 直接以子进程方式拉起一台 microVM(来自官方文档:SDK embeds the runtime, creates a local VM as a child process)。命令通过 VM 里的 guest agent(管家在 VM 里的对接人)投递执行。
3. **VM 内部真实执行**:`uname -srm` 返回 `Linux 6.12.99 aarch64`——注意是 **Linux**,而我们宿主机是 macOS(执行 `uname` 会显示 Darwin)。这条输出就是"独立内核"的铁证:容器会显示和宿主同一个内核,这里没有。
4. **结果被包成 `ExecOutput` 送回来**:`.stdout_text` / `.stderr_text` / `.exit_code` 三个字段,和普通 subprocess 结果长得差不多,SDK 使用上几乎无感。
5. **`async with` 退出即销毁**:加上 `ephemeral=True`,沙箱停止后连落盘状态一起删。攻击者在里面种的后门、下的马,随 VM 一起灰飞烟灭。

**捣乱视角**:我们故意在 VM 里 `ls /Users`(macOS 的用户目录)。返回 `cannot access '/Users': No such file or directory`——宿主机的文件系统对 VM 完全不可见。如果这是一台容器配错了挂载,这里本该看到你家所有文件。

## 新技术点:Sandbox.create() 与 sb.shell()

- **名字**:`microsandbox.Sandbox`(Python SDK,pip 包名 `microsandbox`,Rust 核心 + Python 绑定)
- **作用**:一行代码拉起一台硬件隔离的 microVM。和 `subprocess` 的区别:subprocess 是在你自己家里开一扇门让外人进来干活;Sandbox 是把外人带到隔壁一次性板房里干活,干完连板房一起拆。
- **关键参数**(完整列表见 `SandboxConfig`):
  - `name`:沙箱名字(也成 VM 里的主机名,好认)
  - `image`:OCI 镜像,如 `"python:3.12"`——就是 Docker Hub 上那个,直接复用容器生态
  - `ephemeral=True`:用完即焚,停止后状态全删。给 Agent 当执行环境必须开
  - `network=Network(...)`:出网策略,默认"public"档案=**随便出网**(实测 curl httpbin 返回 200)。⚠️ 这正是缺口 1,阶段 23 要用 `NetworkPolicy` 收白名单
  - `secrets=[...]`:按域名注入密钥,阶段 27 的对照阅读材料
- **用法**(本项目探针,`/tmp/msb_probe.py`):

```python
async with await Sandbox.create(name="probe", image="python:3.12", ephemeral=True) as sb:
    out = await sb.shell("uname -srm")   # shell() 走 /bin/sh, exec(cmd, args) 不走 shell
    print(out.stdout_text)               # Linux 6.12.99 aarch64
# 出了 with 块,VM 已被杀掉并删除
```

注意两个坑:① `create` 是异步的且返回异步上下文管理器,`async with await` 一个都不能少;② 首次拉镜像要几分钟,之后本地缓存,本次闭环(已缓存)全程 15 秒。

## 关键顿悟

- **"独立内核"不是口号,是一条 uname 输出**:容器里 `uname` 显示的是宿主机的内核;这里显示 `Linux 6.12.99` 而宿主是 macOS——隔离级别的差异,一行输出就能看见。
- **默认网络是敞开的**:microsandbox 默认档案允许出网(实测 200)。它的定位是"可信默认值让 demo 能跑",不是"安全默认值"。白名单要自己配,这是阶段 23 的活。
- **用完即焚是安全属性,不是洁癖**:`ephemeral=True` 把"攻击者留下的持久化后门"这个威胁直接从根上删掉——没有"下一次启动",就没有持久化。

## 附:阶段 21 三连问(概念澄清)

> 用户在阶段 21 后连续追问的三个概念问题,答案整理于此。

**Q1:microVM 和 Docker 容器的区别是什么?**

一句话:Docker 是"同一个内核上的隔离房间",microVM 是"一台独立的小电脑"。

- **内核(最关键)**:容器没有自己的内核,容器里的进程直接调宿主机内核,只是被 namespace/cgroups 挡着;microVM 有自己完整的 Linux 内核(本阶段实测:沙箱里 `uname` 是 Linux 6.12.99,宿主是 macOS)。安全含义:容器里一个内核漏洞就能穿墙到宿主机(共享内核=共享攻击面);microVM 里打穿 VM 内核后,还要再打穿硬件虚拟化层才够得着宿主机——两道墙。
- **虚拟化方式**:Docker 是操作系统级虚拟化(纯软件隔离);microVM 是硬件虚拟化(CPU 虚拟化指令芯片级兜底),和 AWS Lambda 用的 Firecracker 同一家族。
- **代价**:传统虚拟机开机要几分钟,microVM 砍掉 BIOS、设备模拟等累赘,实测"创建→跑命令→销毁"全程 15 秒,可以一次工具调用开一台、用完烧掉。
- **本项目分工**:路线 1 的加固 Docker 没做错(非 root/只读 fs/限额都有效),问题是共享内核 + 默认能出网(缺口 1 的实测)。路线 2 里它降级为对照基线,阶段 24 用同一段逃逸代码两边各跑一遍做实证对比。

**Q2:microsandbox 只能在 Mac 上用吗?Linux 和 Windows 呢?**

三平台都支持,各走各的硬件虚拟化接口,上层 SDK 用法完全一样:

- **macOS**:仅 Apple Silicon(M 系列),走 Hypervisor.framework;Intel Mac 明确不支持,Rosetta 也不行(见[官方 macOS 故障排查](https://docs.microsandbox.dev/troubleshooting/macos))。
- **Linux**:要求内核开 KVM,x86_64 和 ARM64 都有官方包;这是底层 libkrun 的"老家",最成熟(裸机冷启动约 320ms)。
- **Windows**:Windows 10/11 开 WHP(Windows Hypervisor Platform)可跑,官方标注 **preview**,最嫩(见 [PyPI microsandbox](https://pypi.org/project/microsandbox/))。

规律:microVM 必须踩在硬件虚拟化上,每个平台要一扇"通往 CPU 虚拟化能力的门"——Mac 是 Hypervisor.framework,Linux 是 KVM,Windows 是 WHP。libkrun 把三扇门都接了。另有 cloud backend:本地没虚拟化条件时(Intel Mac、普通 CI 机),沙箱可以开到云上,代码只换 backend 配置。

**Q3:microsandbox 是虚拟机吗?和"沙箱"是什么关系?**

- **microsandbox 是工具名,它造出来的是真虚拟机**。这个项目 = 运行时 + SDK(你装的 `msb` 和 Python 包);每次 `Sandbox.create()` 造一台货真价实的虚拟机(独立内核/文件系统/网卡,靠硬件虚拟化跑),只是"微型"——砍了累赘,秒级启动。能跑另一个操作系统的内核,这只能是虚拟机,容器做不到。
- **"沙箱"不是一种技术,是一种效果描述**:给不可信代码一个随便折腾但折腾不出事的环境——像小孩的沙坑,怎么挖都行,沙子不撒到客厅。它只规定效果,不规定实现。实现路线按隔离强度递增:进程级限制(浏览器标签页)→ 容器(共享内核)→ 用户态内核(gVisor,拦截对真内核的调用)→ **microVM(独立内核 + 硬件虚拟化,最硬)**。
- 准确说法:microsandbox 是用"微型虚拟机"这种最硬的技术,实现"沙箱"这种效果的工具,名字本身就是 micro(微型)+ sandbox(沙箱)。
