# 路线 2 堡垒执行

Type: task
Status: open
Blocked by:

> 执行交接文档（新窗口开工先读）：`issues/09-route2-execution/HANDOFF.md`

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
