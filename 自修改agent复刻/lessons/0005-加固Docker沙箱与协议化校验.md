# 0005 - 阶段 5:加固 Docker 沙箱与协议化校验

## 1. 三问(这一阶段是干嘛的)

**位置感**:

```
✅ 1 看病  ✅ 2 确诊  ✅ 3 开药  ✅ 4 安检
✅ 5 隔离病房:加固 Docker 容器跑候选      ← 你在这里
⬜ 6/7 体检:容器内 7 项语义检查
⬜ 8 放行决定 + manifest
⬜ 9 可信根自证(SHA-256)
⬜ 10 真实 LLM 提案(MiniMax)
⬜ 11 验收入口:负对照必拒 + 三方同门槛
⬜ 12 对照收官:加固 Docker vs microVM
```

**这一步是干嘛的?** 给候选代码建"隔离病房":宿主机写一个 Docker 驱动(`candidate_sandbox.py`),把候选源码用 JSON 包好从 stdin 塞进一次性容器,容器里的入口程序(`sandbox_runner.py`)收到后回一份 JSON。本阶段容器只回"我看见了什么"(778 字节源码、3 条轨迹),语义检查阶段 6-7 再点亮。

**什么需求逼的?** 阶段 4 说了:AST 拒绝列表挡得住直球挡不住绕行,而**验证候选"行为对不对"终究要执行它**。执行不可信代码,就必须在一个"它做什么都出不来"的地方做——禁网(不许偷数据出去)、只读文件系统(不许留后门)、非 root + 全降 cap(不许提权)、限内存限 CPU 限进程数(不许拖垮宿主)。

**解决了什么麻烦?** 把"执行不可信代码"变成一个**协议问题**:宿主不关心容器里发生了什么,只认 stdout 回来的、格式合规的 JSON;格式不对、超时、退出码非零、输出超限……一律 `SandboxError`,按"检查失败"处理。**fail closed(关死失败)**:没验成 ≠ 验过了,宁可全灭也不放行。

## 2. 全链路一览

```
宿主(candidate_sandbox.py)                容器(一次性,跑完即删)
┌────────────────────────────┐            ┌──────────────────────────┐
│ 1 限幅:源码≤256KiB 请求≤1MiB │   stdin    │ sandbox_runner.py        │
│ 2 镜像:内容寻址,不在就构建  │ ═════════▶ │ (python -I,非 root)      │
│ 3 docker run + 加固 flag 群 │            │  读 stdin(≤1MiB 限幅)    │
│ 4 等待,墙钟 8 秒超时        │ ◀═════════ │  验协议,回 {"ok":..}     │
│ 5 只认合规 JSON,否则        │   stdout   │  退出码 0,否则算失败      │
│   SandboxError              │            └──────────────────────────┘
└────────────────────────────┘
→ demo 打印回传 JSON + 灯表 sandbox_execution ✓
```

## 3. 跟着数据走:一次沙箱往返

**第 1 步,宿主打包**(`candidate_sandbox.py` 的 `run_in_sandbox`):请求 = `{"action": "ping", "source": <候选全文>, "trajectories": <3 条轨迹>, "stable_source": <稳定版全文>}`,打空前先过三道尺寸闸:源码 ≤ 256 KiB、序列化后 ≤ 1 MiB,超了直接 `SandboxError`,容器都不用起。

**第 2 步,镜像从哪来?** 镜像名不是随便起的:`sandbox:{sha256(Dockerfile+runner)前12位}`——**内容寻址**。Dockerfile 或 runner 改一个字节,名字就变,`docker image inspect` 找不到就按锁定的 Dockerfile 现场构建。**捣乱思路走一遍**:假如有人偷偷改了容器里的 runner(比如让它无条件回 `ok:true`),会怎样?改的是本机镜像?没关系,下次运行时按新哈希找不到镜像,重新从 Dockerfile 构建一份干净的——镜像永远和源码对得上号。这和阶段 3 的"恰好匹配一次"是同一个思想:先确认世界还是你以为的样子。

**第 3 步,加固 flag 群**(`_docker_command`,candidate_sandbox.py:56-80):`--network none`(断网)、`--read-only`(根文件系统只读,只给 16MB 无执行权限的 /tmp)、`--user 65534:65534`(nobody,非 root)、`--cap-drop ALL` + `no-new-privileges`( capabilities 全丢 + 禁提权)、`--pids-limit 16` / `--memory 64m` / `--cpus 0.5` / `ulimit` 群(资源限幅,防 fork 炸弹和资源耗尽)、`--rm`(跑完即删,一次性)。

**第 4 步,宿主只认协议**。8 秒墙钟超时(超时先 `docker rm --force` 杀容器再报错);退出码非 0 → 报错;stdout 不是 JSON、或 `ok` 不是 `true`、或没有 `result` 对象 → 全部 `SandboxError`。本次实测回传:`{"action": "ping", "source_bytes": 778, "trajectories_seen": 3}`——宿主对容器内部唯一的了解就是这一句话。

**第 5 步,接进灯表**:`validate_candidate`(evolution.py)在静态两格全过后调 `run_in_sandbox`,`SandboxError` 被捕获、灯表保持全灭。捣乱候选(import os)连沙箱门都没摸到——在静态闸就被拦了,沙箱的钱没花。

## 4. 新技术点:Docker 一次容器的最小安全配方

- **名字**:Docker `run` 的安全/资源 flag 群(阶段 12 要拿 microsandbox 一次性 microVM 和这套对照)。
- **作用**:一条命令把"跑不可信代码"的爆炸半径收到最小。默认 `docker run` 其实很松(有网、root、全 capabilities),安全不是 Docker 的默认,是**这些 flag 的叠加**。
- **关键参数**(按"拦什么"分组):网络/通信 `--network none`、`--ipc none`;文件系统 `--read-only` + `--tmpfs /tmp:noexec`(要写也只能写到不能执行的临时区);身份 `--user 65534:65534` + `--cap-drop ALL` + `--security-opt no-new-privileges:true`;资源 `--pids-limit`/`--memory`/`--memory-swap`(内存+swap 一起限,否则 swap 会绕过内存上限)/`--cpus`/`--ulimit`;痕迹 `--rm` + `--log-driver none`(不落日志,不留容器)。
- **用法**(candidate_sandbox.py:56-96 就是完整清单):注意 `ENTRYPOINT ["python", "-I", ...]`(Dockerfile.sandbox:6)里的 `-I` 是 Python 隔离模式:不加载用户 site-packages 和环境变量,容器内环境也被收干净。

## 5. 关键顿悟

- **fail closed 是沙箱的魂**:超时、OOM、Docker 不在、协议不合规……任何"没拿到可信结果"的情况,结局都是灯灭,绝没有"大概没问题吧"。安全系统里,失败的默认方向必须是"关"。
- **内容寻址 = 镜像和源码的绑定**:镜像名由 Dockerfile+runner 的哈希派生,想用被动手脚的镜像,得先让哈希对上——做不到。与阶段 9 的可信根自证一脉相承。
- **宿主与容器的唯一通道是协议**:宿主不 import 容器里的代码(参考项目甚至明令禁止宿主 import sandbox_runner),不解析候选代码的任何行为,只认一份 JSON。"不信任"落实成"只通过窄口子交换结构化数据"。
- **诚实标注**:参考版用有界读线程流式限幅输出,本复刻简化为 communicate+事后限幅——处置语义一致(fail closed),但恶意容器理论上可先占宿主内存,已记入 learning-record,阶段 12 收官时复核。
