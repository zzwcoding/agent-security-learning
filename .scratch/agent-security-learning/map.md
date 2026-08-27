# Map: Agent 安全学习项目

## Destination

走完图纸路线 1–3 全部 + 路线 4 红队部分（推理端与端云隐私降为"熟悉即可"），交付物沉淀在本目录 `deliverables/`，能用 JD 的语言讲清每个设计决策。

## Notes

- 领域：LLM Agent 安全学习；全职冲刺 6–10 周；macOS（Apple Silicon）+ Docker，无 Linux KVM
- 颗粒度约定：本地图只解决决策，实现由用户完成；步骤级指导以图纸为准；需要更细落地讨论时单开 prototype 票
- 交付物位置：本目录 `deliverables/`；起步 Agent 位于本目录 `starter-agent/`
- 每次会话应参考：`CONTEXT.md`（术语）、图纸（`LLM-Agent安全学习路线规划.md`）、靶场（`Agent安全调研总结.md`）、练兵场（`../深入理解agent 实验/ai-agent-book/.local/security-scan/SECURITY-EXPERIMENTS.md`）
- 范围档位：路线 1/2/3 全量 + 路线 4 红队部分全量；路线 4 端云隐私与推理端项目降为熟悉

## Decisions so far

<!-- 已解决票的索引：一行一票，gist + 链接 -->

- [Mac 上的 microVM 选型](issues/04-microvm-on-mac.md): 主线 microsandbox（libkrun 原生支持 Apple Silicon，一行安装）+ E2B 云 SDK 作对照 + 加固 Docker 作基线；Daytona 排除（开源停更）；Firecracker/gVisor 文档精读不受平台影响。
- [红队工具链选型](issues/06-redteam-toolchain.md): garak + PyRIT 全量用（前者宽谱扫描，后者编排攻击并进 CI 回归），A.I.G 只取 mcp-scan CLI 扫工具层，AgentDojo 仅作注入语料与评估方法论参考
- [MCP 网关选型](issues/05-mcp-gateway-choice.md): 选 IBM mcp-context-forge——全功能开源（JWT/RBAC/插件链/SSRF 防护齐全）、单一 Python 代码库最适合精读；lunar-dev/mcp-x 实为 TheLunarCompany/lunar 的 mcpx 子目录，核心治理能力在 enterprise 档读不到源码

## Not yet specified

- 路线 2–4 在起步 Agent 上的落地化方案（随路线推进逐关具体化，第一张已由「路线 1 守门员落地化方案」开出）
- "熟悉即可"档的检验形式（讲给谁、什么载体）
- 面试材料的最终形态（各关复盘文档如何组织成可讲的整体）
- 练兵场 23 个强安全实验的精读排期（穿插进哪几周）

## Out of scope

- chapter8 训练侧安全（RLVP / DPO / reward hacking）：属模型后训练，不在 JD 射程内
- 合规标准（NIST AI RMF / EU AI Act）：求职被问到时再补
