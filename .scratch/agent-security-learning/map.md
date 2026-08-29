# Map: Agent 安全学习项目

## Destination

走完图纸路线 1–3 全部 + 路线 4 红队部分（推理端与端云隐私降为"熟悉即可"），交付物沉淀在本目录 `deliverables/`，能用 JD 的语言讲清每个设计决策。

## Notes

- 领域：LLM Agent 安全学习；全职冲刺 6–10 周；macOS（Apple Silicon）+ Docker，无 Linux KVM
- 颗粒度约定：本地图只解决决策，实现由用户完成；步骤级指导以图纸为准；需要更细落地讨论时单开 prototype 票
- 交付物位置：`.scratch/agent-security-learning/deliverables/`；起步 Agent 位于 `.scratch/agent-security-learning/starter-agent/`
- 每次会话应参考：`CONTEXT.md`（术语）、图纸（`LLM-Agent安全学习路线规划.md`）、靶场（`Agent安全调研总结.md`）、练兵场（`../深入理解agent 实验/ai-agent-book/.local/security-scan/SECURITY-EXPERIMENTS.md`）
- 范围档位：路线 1/2/3 全量 + 路线 4 红队部分全量；路线 4 端云隐私与推理端项目降为熟悉

## Decisions so far

<!-- 已解决票的索引：一行一票，gist + 链接 -->

- [起步 Agent 搭建](issues/01-starter-agent.md): 已建成于 `starter-agent/`（LangGraph ReAct + 手写 filesystem/shell/fetch 三个 MCP server，核心 246 行，MiniMax-M2 经 Keychain 注入）；三项验收（读→总结→写、三工具真实调用、docker build）全过，记忆跨容器持久已修复；分阶段教学见 `issues/01-starter-agent/lessons/0001–0008`
- [Mac 上的 microVM 选型](issues/04-microvm-on-mac.md): 主线 microsandbox（libkrun 原生支持 Apple Silicon，一行安装）+ E2B 云 SDK 作对照 + 加固 Docker 作基线；Daytona 排除（开源停更）；Firecracker/gVisor 文档精读不受平台影响。
- [红队工具链选型](issues/06-redteam-toolchain.md): garak + PyRIT 全量用（前者宽谱扫描，后者编排攻击并进 CI 回归），A.I.G 只取 mcp-scan CLI 扫工具层，AgentDojo 仅作注入语料与评估方法论参考
- [MCP 网关选型](issues/05-mcp-gateway-choice.md): 选 IBM mcp-context-forge——全功能开源（JWT/RBAC/插件链/SSRF 防护齐全）、单一 Python 代码库最适合精读；lunar-dev/mcp-x 实为 TheLunarCompany/lunar 的 mcpx 子目录，核心治理能力在 enterprise 档读不到源码
- [路线 1 守门员落地化方案](issues/02-route1-plan.md): 三类攻击全做（直接/间接/记忆投毒）；llm-guard 两路扫输入+工具返回、Secrets 扫输出；容器网络保留其余收紧，egress 记已知缺口；约 2 周节奏；验收 = 复盘文档 + 防御回归 + 缺口清单三件
- [路线 1 守门员执行](issues/07-route1-execution.md): ✅ 已完成（2026-08-29）。三类攻击无防御全中招 → 三层护栏（llm-guard 输入/工具返回分块/输出 Sensitive）→ 容器六项加固 → Langfuse trace+掩码；精读升级为平行窗口复刻/实践（`攻防矩阵复刻/`、`执行工具复刻/`、`NeMo-Guardrails学习/`）；交付物在 `deliverables/route1/`；7 条缺口归属：egress→路线 2，记忆/执行闸/参数侧→路线 3，格式毒漏判等→路线 4 种子
- [总体排期与里程碑](issues/03-schedule.md): 滚动式排期——无死线，只细化当前关，收官时按缺口清单排下一关；主干顺序 路线2→3→4红队→熟悉档+面试材料+架构蓝图；实验角色升级为复刻+精读；路线 3 验收含缺口 2/3/7 核销，Presidio 压至 1 天

## Not yet specified

- 路线 3–4 在起步 Agent 上的落地化方案（路线 1/2 已开票：02、08）
- "熟悉即可"档的检验形式（讲给谁、什么载体）
- 面试材料的最终形态（各关复盘文档如何组织成可讲的整体）

## Out of scope

- chapter8 训练侧安全（RLVP / DPO / reward hacking）：属模型后训练，不在 JD 射程内
- 合规标准（NIST AI RMF / EU AI Act）：求职被问到时再补
