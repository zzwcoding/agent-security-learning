# 0027 — 进程级白名单 vs microVM 级隔离:同一个问题,两种哲学

> 参考:`ai-agent-book/chapter6/async-agent`(实验 6-2「Flux」异步 Agent 运行时;⚠ 票 08/MISSION 误记为 chapter5,实为 chapter6)。
> 本篇是对照讨论,不落地参考项目的白名单——那条路线已被主线阶段 21-23 的 microVM 方案替代,但要讲清楚"为什么"。

## 1. 参考项目做了什么

Flux 是一个异步 Agent 运行时(工具后台跑、事件批量回灌、可打断),安全设计全在"终端命令"这一个工具上,叫**进程级白名单**:

```python
# tasks.py — 白名单判定:LLM 给的 command 字符串只被"解析",从不被执行
def resolve_job(command: str) -> tuple[str, float]:
    parts = shlex.split(command)
    if len(parts) != 2 or Path(parts[0]).name not in {"python", "python3", ...}:
        raise ValueError("only `python <approved-analysis-script>.py` commands are allowed")
    script = Path(parts[1]).name
    if script not in _COMMANDS:            # 脚本名必须在枚举清单里
        raise ValueError(f"unapproved experiment command: {script}")
    return _COMMANDS[script]

# 执行:shell=False 的裸 exec + Python 隔离模式
argv = [sys.executable, "-I", "-u", WORKER, "--job", job, "--rate", rate,
        "--tick-real", TICK, "--input", DEFAULT_INPUT]     # ← 宿主拼装,不是 LLM 拼的
process = await asyncio.create_subprocess_exec(*argv, cwd=HERE,
        stdin=asyncio.subprocess.DEVNULL, stdout=..., stderr=...)
```

四个防御动作,每个都值得单独记:

1. **白名单的对象是"可执行档位"**:`python <批准的脚本>`,连参数个数都限死——LLM 的"命令"只是个显示性说法,真正执行的 argv 由宿主代码拼装。
2. **`shell=False` 的 `create_subprocess_exec`**:不经过 shell 解释器,分号/管道/反引号/`$()`/通配符这些注入面**物理上不存在**。
3. **`python -I`(isolated mode)**:忽略 `PYTHONPATH`、用户 site-packages 等环境注入——连解释器自己的配置面都掐掉。
4. **完整性回执**:worker/输入/argv 的 SHA-256 全记进 `executable_receipt`,取消走 terminate→2s→kill 宽限阶梯。

## 2. 和我们方案的正交关系

主线的 microVM 级(阶段 22-23)白名单的对象是**网络出口域名**(fetch 只许 httpbin.org);参考项目白名单的对象是**可执行档位**(只许跑哪个脚本)。两道闸管的不是同一件事:

| | 参考项目(进程级) | 主线(microVM 级) |
|---|---|---|
| 闸管什么 | **能跑什么**(可执行枚举) | **能去哪**(egress 域名)+ 跑在哪(一次性 VM) |
| 执行面 | 与宿主同内核、同 UID 的普通子进程 | 独立内核的一次性 microVM |
| 命令解释层 | `shell=False` + `python -I` + 宿主拼装 argv | 无解释层(VM 内裸 curl/bash) |
| 打穿后果 | 子进程即宿主用户进程:文件/网络按宿主 UID 全暴露 | VM 内 root 满血,但宿主零可见、私网全拒、用完即焚 |
| 信任根 | 宿主内核 + "被批准的代码不作恶" | VM 边界(hypervisor),不信任 VM 内任何东西 |
| 适配任务面 | **可枚举**(固定几个分析档位) | **不可枚举**(任意 shell)、跑不可信代码 |

一句话:**进程级白名单管"能跑什么",microVM 管"跑的地方能碰到什么"**——它们是正交的两层,不是竞争方案。参考项目的威胁模型假设"被批准的脚本无害"(worker 是宿主自己写的分析器);我们的威胁模型假设"VM 里跑的一切都是恶意的"。假设越狠,需要的边界越硬。

## 3. 判据:什么时候进程级够用,什么时候必须上 microVM

- 任务面**可完全枚举**(命令形态固定)、数据不敏感、代码全是自己写的 → 进程级白名单够,成本低到几行代码(参考项目连 Python 隔离模式都用上了,值得学)。
- 执行面不可枚举(任意 shell)、跑不可信代码、或进程要碰敏感数据 → 必须 microVM 级:因为进程级的一切约束(白名单、shell=False)都作用在**解释层**,而解释层打穿后没有任何内核边界兜底——同 UID 子进程和 Agent 本体在内核眼里是平等的(lesson 0019 的结论在这里再次兑现)。
- 我们的项目四条验收(阶段 31)之所以成立,靠的是"假设已失守"的 VM 边界;参考项目的验收能成立,靠的是"任务面可枚举"。**先审自己的威胁模型,再选边界**——这个决策次序比任何具体技术都重要。

## 4. 值得反向借鉴的一点

参考项目把每次执行的 worker/输入/argv 哈希记进回执——这是**执行完整性审计**。我们的五要素审计(阶段 29)记了"调了什么工具带什么参数",但没有参数指向内容的哈希。VM 一次性让这个意义减弱(VM 内代码本来就不受信),但如果要给 shell 审计加一个低成本增强:**把 command 的 SHA-256 记进审计观测**,复盘时就能证明"审计里这条命令和实际执行的字节一致"。记入路线 3+ 的待办池。
