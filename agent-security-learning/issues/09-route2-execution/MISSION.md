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
| 22 | shell 工具进 microVM:`run_command` 改经 SDK 在一次性 microVM 执行;可观察变化:Agent 里 `ls /` 看到的是 microVM 文件系统 | ✅ 已完成(2026-08-30;lesson 0019,record 0023;MCP 协议实证一次性:首调写 /tmp/pwned,次调不可见;两次调用 1.2s) |
| 23 | fetch 工具进 microVM + egress 白名单(初值 `httpbin.org`)——**缺口 1 核销点** | ✅ 已完成(2026-08-31;lesson 0020,record 0024;工具层白名单 fail closed:httpbin 200,example.com/内网 IP/file 协议拒且不拉 VM;网络层 PUBLIC profile 兜底:VM 内裸跑也够不着私网/元数据,全 exit 7;SDK 0.6.16 domain 白名单规则失效的 beta 坑已记,六轮探针定型两层防御;顺手修 /tools /call 只连 filesystem 的旧账) |
| 24 | 边界对比:同一段逃逸代码(读宿主路径/扫内网/提权)在加固 Docker 与 microVM 各跑一遍,留证据 | ✅ 已完成(2026-08-31;lesson 0021,record 0025;探针在 `escape-probe/`,三份原始证据在 `escape-probe/evidence/`;Docker:挂载卷直通+内网/元数据全可达但权限捆死;microVM:root 不设防但宿主零可见+私网全拒+用完即焚;修正阶段 21 结论——microsandbox 网关默认就拒私网) |
| 25 | chapter9/self-modifying-agent 对照复刻(平行窗口,产物放本文件夹 `self-modifying-agent复刻/`) | ✅ 已完成(2026-08-31;复刻窗口 12 阶段全部走完,产物在仓库根目录 `自修改agent复刻/`(用户指定);lessons 0001-0012 + records 0001-0012 自编号;16/16 验收 gate 全过,负对照必拒,真 LLM(MiniMax-M2)与确定性提案同门槛双 release_to_canary;收官对照:同一 runner 双后端灯表 100% 一致,`对照复盘-验证沙箱选型.md` 落定选一次性 microVM(可供阶段 33 边界对比报告引用)) |
| 26 | 凭证代理 LLM 路:~100 行本地代理,Agent `base_url` 指向代理,代理从 Keychain 注入真 key 转发;Agent 环境只剩 `PLACEHOLDER` | ✅ 已完成(2026-08-31;lesson 0022,record 0026;proxy.py:占位符直连 401 vs 经代理 200,SSE 流式透传,Agent 零 LLM 环境变量裸启动真跑通,代理日志不落 body,无 key 拒启;启动脚本拆为 run-proxy.sh+run-agent.sh) |
| 27 | 凭证代理 fetch 路:`{{SECRET:name}}` 占位符按目标域名匹配替换,域名不在策略表 → fail closed;策略表与 egress 白名单同处 | ✅ 已完成(2026-08-31;lesson 0023,record 0027;fetch_server 策略表+Keychain 现取:httpbin 回显真值/CLI /call 通过,未授权名与不存在的名均 fail closed(策略检查先于取值,不泄露 Keychain 存量);注入点因 VM 出网限制定在 fetch_server 而非 proxy.py,LLM 路不变;microsandbox per-domain secret 三行对照笔记已记) |
| 28 | Presidio 脱敏:`memory.json` 落库前 Analyzer→Anonymizer;encrypt 可逆模式只画数据流图;手画 pipeline 数据流图 | ✅ 已完成(2026-08-31;lesson 0024,record 0028;memory_guard.py:NER 复用 en_core_web_sm+自定义 CN_PHONE/CN_ID 识别器;端到端铁证——落盘 6 处 `<CN_PHONE>`、原文 0 残留;encrypt 可逆模式与 pipeline 两张数据流图已画;记录 L4 对 PII 类话术连续 4 次误报) |
| 29 | OTel GenAI 审计字段(谁/何时/以何理由/调什么工具带什么参数/碰什么数据分级)落到 Langfuse trace metadata | ✅ 已完成(2026-08-31;lesson 0025,record 0029;审计中间件每工具一条五要素观测+trace 级 when/why;OTLP 出网捕获字节级验证全部在案;踩坑实录:v4 events-only 读 API 不水合 input/metadata,验证绕道写端取证) |
| 30 | chapter3/log-sanitization 复刻(平行窗口;顺手起 Ollama 为路线 4 热身) | ⬜ 施工中(平行窗口;产物 `日志脱敏复刻/`,复刻 1–2 已提交,交接 `HANDOFF-阶段30-日志脱敏复刻.md`) |
| 31 | 四次主动攻击验收:逃逸 / egress / 密钥不可见 / 审计复盘,全程留证据 | ✅ 已完成(2026-08-31;四条全过,证据在 `attack-validation/` 四目录:①逃逸宿主零可见+用完即焚 ②egress 六格全拦含凭证走私拦截+VM 内私网全拒(公网残余如实记录) ③密钥全可见面枚举零命中(真 key 只在 Keychain+代理) ④两次真 Agent 会话 6 轮攻击 14 行审计时间线全量可查(五要素齐全,被拦的也留原文);防线命中:输入护栏 5/5+模型自拒 1+工具层白名单+VM 兜底;顺手抓出并修复 proxy.py gzip 透传 bug(aiter_raw→aiter_bytes);发现 filesystem 路径 double-join 记待办;Langfuse 栈重建丢历史数据,按 v4 events 架构重新取证;lesson 0026,record 0030) |
| 32 | chapter5/async-agent 对照讨论(进程级 vs microVM 级白名单)+ Firecracker design doc、gVisor 架构指南精读对照笔记 | ✅ 已完成(2026-09-01;lesson 0027 对照讨论——async-agent 白名单四动作(档位枚举/shell=False/python -I/SHA-256 回执),判据=任务面可枚举性,与 microVM 正交不竞争,未落地符合既定决策;lesson 0028 精读——攻击面=暴露代码量的光谱原理,Firecracker"不做网络过滤,过滤是宿主层责任"与主线两层出网设计对齐,gVisor 双墙+Gofer+systrap 演进;⚠ 参考项目实际在 chapter6 非 chapter5,已修正 RESOURCES;顺手修 filesystem 路径 double-join(阶段 31 演练发现),stdio 验证双写法等价+逃逸照拒;record 0031) |
| 33 | 收官:`deliverables/route2/` 三件交付物;票 09 写 Answer 关闭 | ⬜ |
