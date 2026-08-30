# 路线 2 堡垒落地化方案

Type: grilling
Status: resolved
Blocked by: 07

## Answer（2026-08-29，用户全部按推荐确认）

1. **microsandbox 接入形态**：方案 A——Agent 回 macOS 宿主机直跑（microsandbox SDK 依赖 Hypervisor.framework，容器内不可用），shell + fetch 两个工具的执行面都进 microVM；fetch 配 egress 白名单，核销缺口 1。路线 1 的加固 Docker 降级为对照基线，用于"容器 vs microVM"逃逸边界对比。
2. **凭证代理分工**：方案 A——自写 ~100 行本地代理全管：LLM 流量（Agent base_url 指向代理，代理注入 MiniMax key 转发）+ fetch 出站按域名占位符替换；microsandbox 内建 per-domain secret 注入只作对照阅读。密钥注入与 egress 白名单收进同一策略点（路线 3 网关思想预演）。
3. **Presidio 落点**（1 天 hands-on）：接 `memory.json` 落库前（Analyzer→Anonymizer），记忆是唯一真实持久化数据资产；encrypt 可逆模式只画数据流图，留给路线 4 熟悉档。
4. **实验复刻穿插**（各约半天）：chapter9/self-modifying-agent 随 microVM 步骤对照复刻；chapter5/async-agent 在 microVM 步骤后作"进程级白名单 vs microVM 级"对照讨论（不落地白名单）；chapter3/log-sanitization 与 Presidio 配对（顺手起 Ollama，为路线 4 端云档热身）。Firecracker/gVisor 设计文档精读照常（半天至一天，纯阅读）。
5. **"劫持无效化"验收四条**：① 逃逸测试——注入得手后 shell 只见一次性 microVM 内部；② egress 核销——fetch 向白名单外域名外泄应被拒；③ 密钥不可见——Agent 进程环境 dump 找不到真 key；④ 审计出齐——攻击全程在 Langfuse 按 OTel GenAI 字段可复盘。交付物 `deliverables/route2/`：边界对比报告 + 劫持无效化验证记录 + 缺口 1 核销记录。

## Question

图纸路线 2（microVM 隔离 → 凭证代理 → 数据脱敏管道 → 结构化审计）如何落在起步 Agent 上：

- microsandbox 的具体接入形态：哪些工具调用进 microVM（shell 工具首选？fetch 是否同进）、与现有容器化的关系
- 简易凭证代理设计（图纸建议 ~100 行自写）：替换当前 Keychain 注入的哪部分、假密钥改造成"占位符 + 出网注入"的最小流程
- Presidio 脱敏管道的数据流图：Analyzer → Anonymizer 接在 Agent 的哪个位置
- OTel GenAI 语义约定的审计字段设计（沿用 Langfuse）
- 核销路线 1 已知缺口清单中的网络 egress 项（microsandbox 白名单）

输入依赖：路线 1 的已知缺口清单、microsandbox 研究结论（issues/04）。
