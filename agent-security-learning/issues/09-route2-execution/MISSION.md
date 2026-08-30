# MISSION: 路线 2 堡垒执行(issues/09)

**一句话目标**:把起步 Agent 改造成"就算被完全劫持也无法造成实质伤害"的形态——执行面进 microVM、凭证出代理、数据落库前脱敏、全程可审计,并用四次主动攻击亲手验证边界。

**为什么学**:守门员(路线 1)证明了"注入防不住是必然"——分类器有误报漏报、拆行能绕、语义闸有盲区。堡垒是心智升级:不再指望拦住注入,而是保证**攻进来之后什么也得不到**——shell 只见一次性 microVM、fetch 出不了白名单、Agent 进程里根本没有真 key、记忆落库前已脱敏。这是"默认沦陷(assume breach)"设计思想的完整 hands-on。

**验收标准**(与 issues/09-route2-execution.md 一致,交付物在 `deliverables/route2/`):
1. 边界对比报告:加固 Docker vs microVM,同一段逃逸代码的边界差异(附实测证据)
2. 劫持无效化验证记录:四次主动攻击(逃逸 / egress / 密钥不可见 / 审计复盘)全过程 + 证据
3. 缺口 1 核销记录:egress 白名单拦截外泄实测 + 对 `deliverables/route1/03-已知缺口清单.md` 的销项说明

**约束**:
- 改造对象唯一:`starter-agent/`(路线 1 收官形态起步),不另起 demo
- 运行形态变更:Agent 从加固容器回 macOS 宿主机直跑(microsandbox SDK 依赖 Hypervisor.framework);加固 Docker 降为对照基线
- 教学记录编号续排:lessons 从 **0018** 起,learning-records 从 **0022** 起;知识卡片续 `知识卡片-碎片/` 现有编号
- 文件归拢:除 `deliverables/route2/` 外,本任务产出全部放本文件夹(`issues/09-route2-execution/`)
- 战利品不变:假密钥 `INTERNAL_API_KEY` + `run_command` 非预期命令
- 真 key 只走 Keychain;`.env` 永远只有假密钥;阶段 2 后真 key 只进代理进程,不进 Agent 进程
- microsandbox 是 beta:先跑通 SDK 最小闭环再改造,踩坑记 record

**阶段路线**(编号续路线 1 的 20;对应票 09 四阶段任务单,颗粒度按教学步长切分):

| 阶段 | 内容 | 状态 |
|---|---|---|
| 21 | microsandbox 安装 + SDK 最小闭环(brew 安装、`msb run python`、`Sandbox.create()` 跑通;beta 探坑 ≤30 分钟) | ✅ 已完成(2026-08-29;lesson 0018,record 0022;CLI/SDK 均 0.6.16,闭环 15 秒) |
| 22 | shell 工具进 microVM:`run_command` 改经 SDK 在一次性 microVM 执行;可观察变化:Agent 里 `ls /` 看到的是 microVM 文件系统 | ⬜ |
| 23 | fetch 工具进 microVM + egress 白名单(`allowed_hosts` 初值 `httpbin.org`)——**缺口 1 核销点** | ⬜ |
| 24 | 边界对比:同一段逃逸代码(读宿主路径/扫内网/提权)在加固 Docker 与 microVM 各跑一遍,留证据 | ⬜ |
| 25 | chapter9/self-modifying-agent 对照复刻(平行窗口,产物放本文件夹 `self-modifying-agent复刻/`) | ⬜ |
| 26 | 凭证代理 LLM 路:~100 行本地代理,Agent `base_url` 指向代理,代理从 Keychain 注入真 key 转发;Agent 环境只剩 `PLACEHOLDER` | ⬜ |
| 27 | 凭证代理 fetch 路:`{{SECRET:name}}` 占位符按目标域名匹配替换,域名不在策略表 → fail closed;策略表与 egress 白名单同处 | ⬜ |
| 28 | Presidio 脱敏:`memory.json` 落库前 Analyzer→Anonymizer;encrypt 可逆模式只画数据流图;手画 pipeline 数据流图 | ⬜ |
| 29 | OTel GenAI 审计字段(谁/何时/以何理由/调什么工具带什么参数/碰什么数据分级)落到 Langfuse trace metadata | ⬜ |
| 30 | chapter3/log-sanitization 复刻(平行窗口;顺手起 Ollama 为路线 4 热身) | ⬜ |
| 31 | 四次主动攻击验收:逃逸 / egress / 密钥不可见 / 审计复盘,全程留证据 | ⬜ |
| 32 | chapter5/async-agent 对照讨论(进程级 vs microVM 级白名单)+ Firecracker design doc、gVisor 架构指南精读对照笔记 | ⬜ |
| 33 | 收官:`deliverables/route2/` 三件交付物;票 09 写 Answer 关闭 | ⬜ |
