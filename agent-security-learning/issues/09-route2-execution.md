# 路线 2 堡垒执行

Type: task
Status: closed
Blocked by:

> 执行交接文档（新窗口开工先读）：`issues/09-route2-execution/HANDOFF.md`

## Answer(2026-09-01)

**交付物位置**(`deliverables/route2/` 三件):
1. `01-边界对比报告.md`——同一段逃逸代码在加固 Docker vs 一次性 microVM 的七连探针实测 + 阶段 25 复刻双后端灯表 100% 一致 + Firecracker/gVisor 光谱理论;判决:一次性 microVM 胜,Docker 降备选(保留场景写明)
2. `02-劫持无效化验证记录.md`——四次主动攻击(逃逸/egress/密钥不可见/审计复盘)全过:输入护栏 5/5+模型自拒 1+白名单 fail closed(2–4ms vs 2.4s 差三个数量级)+VM 兜底;6 轮真 Agent 攻击 14 行审计时间线一条不丢;原始证据 `issues/09-route2-execution/attack-validation/`
3. `03-缺口1核销记录.md`——两层出网防御(工具层白名单+凭证策略 fail closed,VM 网关 PUBLIC profile 兜底);`deliverables/route1/03-已知缺口清单.md` 第 1 条已回写核销

**验收证据**:
- 逃逸:VM 宿主零可见(无 /Users/无宿主进程/挂载仅 msb_runtime)+ 一次性埋点跨调用消失(阶段 24+31 双实测)
- egress:外泄四连拒 + 凭证走私(`{{SECRET:MINIMAX_API_KEY}}` 借白名单域名)被策略拒 + VM 内私网/元数据 exit=7(攻击②,六格)
- 密钥不可见:可见面枚举五路查证——Keychain(126 字符)与代理进程是仅有的两处,Agent 进程/全仓文本/VM 环境全零(攻击③)
- 审计复盘:14 行时间线含 5 条被拦输入(分数+原文)、6 条工具五要素观测、1 条 ERROR 级(防御链崩掉的那轮也留痕)(攻击④,ClickHouse events_core 直查)

**与方案 08 的偏差**:
1. egress 白名单落点变更:microsandbox 0.6.16 域名粒度 ALLOW 规则**实测无效**(六轮探针,fake-IP DNS 代理只在含 PUBLIC 组规则的策略下工作)——白名单落工具层(自有代码),网络层降为 PUBLIC profile 私网兜底;"策略表与白名单同处"兑现为 fetch_server 顶部两常量
2. 凭证注入分工拆两处:LLM 路在 `proxy.py`(Authorization 注入+SSE 透传),fetch 路因 VM 出网限制不在代理、在 `fetch_server`(占位符→域名策略→Keychain 现取);"一体代理全管两路"拆为"同一思想、两个注入点"
3. 复刻升级:chapter9 自修改 agent 为 12 阶段完整复刻(平行窗口,`自修改agent复刻/`,收官拍板验证沙箱选一次性 microVM);chapter3 log-sanitization 为 11 阶段完整复刻(平行窗口,`日志脱敏复刻/`,收官拍板三出口分工:memory.json=Presidio,trace/日志=regex 在线+hybrid 离线);chapter5/async-agent **实际在 chapter6**(票 08/规划误记,已修正),按既定决策仅对照讨论未落地(lesson 0027)
4. 新增审计中间件层(方案只要求"落 metadata"):OTel GenAI 五要素以 `wrap_tool_call` 中间件旁路观测落地,ask() 外包 cli-round trace 壳修孤立 trace;langfuse v4 读 API 不水合,验证走 OTLP 出网捕获+ClickHouse events_core 直查(lesson 0025)
5. 攻击演练抓出并修两 bug:proxy.py gzip 透传(aiter_raw→aiter_bytes+Content-Encoding 不透传)、filesystem 路径 double-join;Langfuse 栈 8-31 重建丢历史 trace(卷未保留),阶段 33 证据按 v4 事件架构重取
6. microsandbox 从"工具对照阅读"升为执行面主力(方案原文如此,兑现);beta 探坑工时超原计划(六轮 DNS 探针、OTLP 验证绕道)

**残余归属(不阻塞关闭)**:shell 公网出口(VM 内假数据,归路线 3 网关 per-agent 策略)、观测面 LANGFUSE 凭证在 Agent 进程(收口=上报走代理)、`audit.data_class` 静态映射(参数级分级归路线 3)、输入护栏误报率(路线 4 既有科目)。

教学记录:主线 lessons 0018–0028、learning-records 0022–0031(均在 `issues/09-route2-execution/`);复刻窗口自编号:自修改 0001–0013、日志脱敏 0001–0011。根目录新增两份长期参考:《Agent开发分层与语言选型》《沙箱机制与传统安全业务选型调研》。

## Question

按「路线 2 堡垒落地化方案」（issues/08）的已定决策执行，参照量级 3–4 天（不作死线）：

1. **microVM 接入**（约 1 天）：`brew install superradcompany/tap/microsandbox`；Agent 回宿主机直跑；shell + fetch 执行面进 microsandbox，fetch 配 egress 白名单（核销缺口 1）。复刻 chapter9/self-modifying-agent 作对照（半天）；加固 Docker 镜像跑同一段逃逸代码，留对比证据。
2. **凭证代理**（约 1 天）：自写 ~100 行本地代理；LLM base_url 指向代理注入 MiniMax key 转发；fetch 出站按域名占位符替换；Keychain 注入脚本改造（真 key 只进代理进程，不再进 Agent）；microsandbox 内建 secret 注入只对照阅读。
3. **脱敏 + 审计**（约 1 天）：Presidio 接 `memory.json` 落库前（Analyzer→Anonymizer）；encrypt 可逆模式画数据流图（不实现）；OTel GenAI 审计字段设计并落到 Langfuse。复刻 chapter3/log-sanitization（半天，顺手起 Ollama）。
4. **边界验证 + 复盘**（约 1 天）：四次主动攻击验收（逃逸 / egress / 密钥不可见 / 审计复盘）；chapter5/async-agent 复刻对照（半天）；Firecracker design doc + gVisor 架构指南精读。

教学记录沿用 lessons 编号续排；知识卡片沿用路线 1 做法。

验收（`deliverables/route2/` 三件）：
1. 边界对比报告：加固 Docker vs microVM，同一段逃逸代码的边界差异
2. 劫持无效化验证记录：四次主动攻击全过程 + 证据
3. 缺口 1 核销记录：egress 白名单拦截外泄的实测

解决时 Answer 记录交付物位置、与方案 08 的偏差、验收证据。
