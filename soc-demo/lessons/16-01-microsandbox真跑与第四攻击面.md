# 16-01 · microsandbox 真跑与第四攻击面：给 analyzer 一间用完就拆的隔离房

> 票 16 教学文档。前情：票 15 我们给富化 worker 装了 TLP/PAP 闸门和 fixture 情报表——analyzer 的
> 「答案」是查表查出来的，脚本本身从没真正跑过。这一票让 analyzer **真的跑起来**，而且是在一台
> 用完就拆的微型虚拟机（microVM）里跑——顺便让一台「被投毒的 analyzer」现场表演越狱，看沙箱怎么拦。

## 三问（阶段动机）

**位置感**：终极目标是做出一名「带着镣铐跳舞」的 SOC 数字员工。路线图上你已经走到这里：

```
✅ 票 01-08  安全控制面（CI 门禁 / 票契约 / guards / 验票闸 / 凭证代理）
✅ 票 09-12  告警接入 + 编排 + 审批回路 + 三容器并排
✅ 票 13     分诊 worker      ✅ 票 14  调查 worker
✅ 票 15     富化 worker（mock analyzer：查 fixture 情报表）
✅ 票 16 ← 你在这里：analyzer 沙箱真跑 + 第四攻击面（投毒 analyzer 越狱演示）
⬜ 票 17-22  知识沉淀 / Copilot / Web / 评测体系
```

**这一阶段是干嘛的？** 把 analyzer 从「查表返答案」升级成「真脚本在虚拟机里执行」，并验证第四个
攻击面：假如这个 analyzer 本身是坏的（第三方组件被投毒），它想外联 C2、想偷宿主机上的密钥、
想留后门——沙箱要一件件拦下来，而且每拦一件都要在审计里留痕。

**什么需求逼我们这么设计的？** PRD v1.1 变更 2/3：microsandbox 从「保护 shell 执行面」改挂 M6，
analyzer 按 Cortex 真实架构以**可执行脚本**形态存在，每次富化在一次性 microVM 里真跑。为什么非要
真跑？因为 analyzer 是**第三方可污染件**——Cortex 生态里 analyzer 谁都能写，marketplace 装个恶意
analyzer 就等于在 SOC 内部安了内鬼。mock 的查表演不出这层威胁，只有「真跑 + 关笼子」才能演示。

**它解决了什么麻烦？** 以前的隔离靠「约定」：analyzer 你别乱来哦。现在靠「物理」：analyzer 跑在
一台硬件虚拟化的微型虚拟机里，网络是关的、宿主 env 看不见、跑完整台销毁——它连宿主机的门牌号
都摸不到，镣铐从纪律变成了钢筋。

## 全链路一览

```
富化 flow（票 15，零改动）
   │ deps.analyzers ← 这里换实现就「切真跑」（m6 卡 Seam①：默认 mock / 演示切真）
   ▼
MsbAnalyzerBackend（sandbox.ts，本票主角——像给 analyzer 包了一层「隔离房管理员的流程」）
   │ ①定位脚本    vm-analyzers/vt_lookup.py（正常件）或 attack fixture（投毒件）
   │ ②拉 VM       msb run python:3.12 --no-net --copy 脚本 --copy-dir 情报表 -- python …
   │              └─ --no-net：网络全关（C2 外联的死路）
   │              └─ 不带 -e：宿主 env 不进 VM（密钥的死路）
   │ ③真执行      VM 里的 python 跑 analyzer，stdout 吐一行 <<ANALYZER_RESULT>>{result,attempts}
   │ ④拆 VM       finally 里 msb remove -f（成功失败都拆——「一次性」是拆出来的，不是自动的）
   │ ⑤记审计      VM 遥测里的攻击尝试 → DENIED 审计；「没拦住」→ FAILURE 级 breach 审计
   ▼
AnalyzerResult（Cortex 契约形状）→ 照旧走票 15 的 guards 扫描 / artifacts 回写 / 富化报告
```

一句话：**flow 不知道也没必要知道 analyzer 在哪跑**——接缝（AnalyzerBackend 接口）后面是查表
还是虚拟机，换零件不换管道。

## 跟着数据走：一个投毒 analyzer 的越狱现场

布景：`fixtures/attack/sandbox/01_poisoned_analyzer/analyzer.py`，一个表面正常、暗地使坏的
analyzer。它想干三件事：外联 C2（198.51.100.23:4444）、偷宿主机密钥、在磁盘留后门文件。
我们用 `scriptFor` 这个接缝把它换上沙箱的执行位，调用还是那个四元组
`{data: "c05640e2…", dataType: "hash", tlp: 2, pap: 2}`。

1. **拉 VM**。管理员（backend）拼出这条命令：
   `msb run python:3.12 --no-net --name enrich-vt_lookup-3f2a --copy 投毒.py:/srv/analyzer.py …`
   注意 `--no-net` 在场、全程没有一个 `-e`。这台 VM 从出生起就没网、没宿主 env——不是「不许用」，
   是「根本没有」。

2. **VM 里的越狱三连**。投毒脚本真的跑起来了，它的三件事分别撞上三堵墙：
   - `socket.connect_ex(("198.51.100.23", 4444))` → 立刻返回 **errno=111**（连接被拒，0.0 秒）。
     网络栈是宿主侧的，策略直接拒了，连门都没出。
   - `os.environ` 全量扫一遍 → 只有 PATH/HOME/LANG 等 **9 个镜像自带键**。宿主机上明明挂了
     金丝雀密钥 `SOC_CANARY_SECRET=…never-leaks`（就挂在 msb 进程的 env 上），VM 里一个字符都没有。
   - `open("/tmp/pwned","w")` → 在 VM 里**写得进去**（这台 VM 里它确实得手了）——但别急，看第 3 步。

3. **拆 VM**。脚本跑完，finally 里 `msb remove -f enrich-vt_lookup-3f2a`。整台虚拟机连同
   /tmp/pwned 一起蒸发。再拉一台全新 VM 检查：`/tmp/pwned` 不存在，`msb list` 里也没有任何
   enrich- 沙箱。后门随房同拆。

4. **审计留痕**。backend 收到 VM 遥测 `attempts: [{kind:"egress", blocked:true, errno:111},
   {kind:"env_probe", …}]`，翻成两条 DENIED 审计：`sandbox_egress_blocked`、`sandbox_env_denied`，
   五要素齐全（actor=agent:enrichment / objectId=沙箱名 / requestId / createdAt / details 带errno）。
   反过来，如果哪天遥测里出现 `blocked:false`（连接居然成功了），backend 不会把它粉饰成拦截，
   而是记 `sandbox_egress_breach`（FAILURE）——**审计不说谎，拦截和破绽是两种记录**。

5. **对表（正常件）**。换回正常 analyzer：同样的命令、同样的 VM，vt_lookup.py 读挂载进来的
   /srv/ti/c05640e2….json，吐出 malicious 5/70 + artifacts——和票 15 情报表的答案一字不差。
   真跑不是花活，干活的还是同一个逻辑，只是从「管理员代查」变成了「本人在隔离房里亲手查」。

## 新技术点四要素：microsandbox / msb

- **名字**：microsandbox（`msb` CLI，v0.6.16，Homebrew 安装）。基于 libkrun 的本地 microVM 运行时，
  macOS ARM 上不需要 Docker——它是**硬件虚拟化**（每台沙箱是一台真微型虚拟机），比容器隔离强一档；
  不是常驻服务，`msb run` 按需拉起、用完拆掉。
- **作用**：给不可信代码一间「用完就拆的隔离房」。和你已会的 Docker 比：容器共享宿主内核（越狱 =
  找内核的茬），microVM 有自己的内核（想越狱得先越虚拟机监控器）。和票 12 的 compose 三容器比：
  那是常驻服务搬家，这是一次性任务的电闸。
- **参数**（本票用到的，全是 run 的旗标）：
  - `--no-net`：网络全关。宿主侧网络栈双向 deny，VM 里 connect 立即 errno=111。可配 `--net-rule allow@…` 做白名单。
  - `--copy SRC:DST` / `--copy-dir SRC:DST`：开机前把宿主文件/目录拷进 guest 根文件系统（本票挂 analyzer 脚本和情报表）。
  - `--name` / `--label KEY=VALUE`：具名 + 打归属标签（清扫时按标签一锅端）。
  - `--timeout 60s`：命令超时强杀（analyzer 挂死也不许占着 VM）。
  - `run` vs `create/exec`：`run` 是「起一台、跑一条命令」；跑完沙箱是 stopped 状态**留在原地**——要自己 remove。
- **用法**（本项目：services/agent/workers/enrichment/sandbox.ts 的 buildMsbArgs）：

  ```
  msb run python:3.12 --name enrich-vt_lookup-3f2a --no-net --no-tty -q \
    --label soc-demo=ticket16 --timeout 120s \
    --copy /abs/vm-analyzers/vt_lookup.py:/srv/analyzer.py \
    --copy-dir /abs/fixtures/ti:/srv/ti \
    -- python /srv/analyzer.py '{"data":"c05640e2…","dataType":"hash","tlp":2,"pap":2}'
  ```

  新机器先 `msb pull python:3.12`（镜像约 380MB），`msb doctor` 体检虚拟化前提。
  CI 上没 KVM：能力探测（msbProbe）失败就整体 skip 真跑断言并打印原因，mock 侧照常全绿——
  **skip 要喊出来，不许装没这回事**。

## 关键顿悟

- **拦截机制要长在拓扑上，不长在自觉上。** `--no-net` 是这台 VM 出生就没有网络，不靠 analyzer
  「答应不外联」；env 不传就是不传，不靠「答应不偷看」。检验标准：把拦截机制写进命令行参数里，
  CI 上没有真 VM 也能断言这行参数在（拓扑断言）。
- **一次性是动词不是形容词。** msb run 跑完留的是 stopped 沙箱，「跑完即毁」是 backend 在
  finally 里显式 remove 出来的——而且失败路径也要拆，remove 失败本身记 FAILURE 审计。
  安全语义里，「默认会发生」和「有人负责做」是两回事。
- **断言不靠攻击者的自白。** 投毒脚本说「我被拦了」不算数——测试另派自己的探针进同策略 VM
  独立复测 errno、金丝雀、残留文件；遥测里「没拦住」会被记成 breach 而不是拦截。
  审计的真实性不能建立在被审计方的诚实上。
- **对照实验证明因果。** 「C2 连不上」有两种解释：被拦了，或本来就不通。人工对照实验：
  去掉 `--no-net`，errno 从 111 变 0——拦截才归功于旗标。（顺带挖出一个坑：无旗标的 VM 用户态
  网络栈会**假握手**，不可路由地址也立刻 errno=0，演示时千万别拿「connect 成功」当外联证据。）

## 亲手验证

在 soc-demo 目录（`cd /Users/divh/Downloads/安全评估agent/soc-demo`）：

1. **看拓扑**：`grep -n "no-net\|remove\|RESULT_MARKER" services/agent/workers/enrichment/sandbox.ts`
   ——应看到 --no-net 旗标、finally 里的 remove、以及 VM 侧协议 marker 三处。
2. **跑测试（真跑在内）**：`cd services/agent && pnpm vitest run workers/enrichment/sandbox.test.ts`
   ——14 条全过；真跑 3 条各约 0.5 秒（microVM 启动极快）。
3. **手动复演越狱（对照实验）**：
   `msb run python:3.12 --no-net --no-tty -q -- python -c "import socket;print(socket.socket().connect_ex(('198.51.100.23',4444)))"`
   应看到 `111`；把 `--no-net` 删掉再跑，应看到 `0`（假握手）——这两个数字的差别就是沙箱的的价值。
4. **确认无残留**：`msb list` ——应显示 No sandboxes found（每次 lookup 后 backend 都拆干净了）。
5. **捣乱实验**：把投毒脚本里 C2 端口改成 443 再跑测试——仍应全绿（拦的是「外联」这个动作，
   不挑端口）；再把 scenario.json 里 `expected.egress` 改成 `"allowed"`——fixture 完整性测试应立刻
   变红，这就是布景被篡改时的报警。
