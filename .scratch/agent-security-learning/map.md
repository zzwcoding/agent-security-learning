# Map: Agent 安全学习项目

## Destination

路线 1–3 已完成。终点改为：**路线 5 = 最终面试 demo**——TS 实现的 SOC 数字员工（告警分诊与响应助手），含多 agent 协同（LangGraph.js supervisor）、带防护 RAG（Chroma）、Eval 回归体系、人工审批回路；不设时间盒，以充实为先。完成标准 = 能拿去面试：全链路演示 + 攻击演示 + 架构讲解材料。路线 4 红队挂起中，demo 收官后视求职节奏恢复。

## Notes

- 领域：LLM Agent 安全学习 → 面试 demo 项目；macOS（Apple Silicon）+ Docker，无 Linux KVM
- 颗粒度约定：本地图只解决决策，实现由用户完成；步骤级指导以图纸为准；需要更细落地讨论时单开 prototype 票
- 交付物位置：`.scratch/agent-security-learning/deliverables/`；起步 Agent 位于 `.scratch/agent-security-learning/starter-agent/`
- 每次会话应参考：`CONTEXT.md`（术语）、图纸（`LLM-Agent安全学习路线规划.md`）、靶场（`Agent安全调研总结.md`）、练兵场（`../深入理解agent 实验/ai-agent-book/.local/security-scan/SECURITY-EXPERIMENTS.md`）、TS 架构图（`deliverables/review/消息流程图-TS架构设想.html`，v3 已定案 6/6）
- 范围档位：路线 1/2/3 全量完成；路线 4 红队挂起；路线 5 demo 为收口主线
- 当前状态（2026-09-04）：路线 4 红队执行（票 13）挂起第 2 天；复习期已收口（票 15/16）；路线 5 启动，三阶段票已开：17 阶段 A 参考项目深析与需求制造（前沿）→ 18 阶段 B 技术设计 → 19 阶段 C 开发实施

## Decisions so far

<!-- 已解决票的索引：一行一票，gist + 链接 -->

- [起步 Agent 搭建](issues/01-starter-agent.md): 已建成于 `starter-agent/`（LangGraph ReAct + 手写 filesystem/shell/fetch 三个 MCP server，核心 246 行，MiniMax-M2 经 Keychain 注入）；三项验收（读→总结→写、三工具真实调用、docker build）全过，记忆跨容器持久已修复；分阶段教学见 `issues/01-starter-agent/lessons/0001–0008`
- [Mac 上的 microVM 选型](issues/04-microvm-on-mac.md): 主线 microsandbox（libkrun 原生支持 Apple Silicon，一行安装）+ E2B 云 SDK 作对照 + 加固 Docker 作基线；Daytona 排除（开源停更）；Firecracker/gVisor 文档精读不受平台影响。
- [红队工具链选型](issues/06-redteam-toolchain.md): garak + PyRIT 全量用（前者宽谱扫描，后者编排攻击并进 CI 回归），A.I.G 只取 mcp-scan CLI 扫工具层，AgentDojo 仅作注入语料与评估方法论参考
- [MCP 网关选型](issues/05-mcp-gateway-choice.md): 选 IBM mcp-context-forge——全功能开源（JWT/RBAC/插件链/SSRF 防护齐全）、单一 Python 代码库最适合精读；lunar-dev/mcp-x 实为 TheLunarCompany/lunar 的 mcpx 子目录，核心治理能力在 enterprise 档读不到源码
- [路线 1 守门员落地化方案](issues/02-route1-plan.md): 三类攻击全做（直接/间接/记忆投毒）；llm-guard 两路扫输入+工具返回、Secrets 扫输出；容器网络保留其余收紧，egress 记已知缺口；约 2 周节奏；验收 = 复盘文档 + 防御回归 + 缺口清单三件
- [路线 1 守门员执行](issues/07-route1-execution.md): ✅ 已完成（2026-08-29）。三类攻击无防御全中招 → 三层护栏（llm-guard 输入/工具返回分块/输出 Sensitive）→ 容器六项加固 → Langfuse trace+掩码；精读升级为平行窗口复刻/实践（`攻防矩阵复刻/`、`执行工具复刻/`、`NeMo-Guardrails学习/`）；交付物在 `deliverables/route1/`；7 条缺口归属：egress→路线 2，记忆/执行闸/参数侧→路线 3，格式毒漏判等→路线 4 种子
- [总体排期与里程碑](issues/03-schedule.md): 滚动式排期——无死线，只细化当前关，收官时按缺口清单排下一关；主干顺序 路线2→3→4红队→熟悉档+面试材料+架构蓝图；实验角色升级为复刻+精读；路线 3 验收含缺口 2/3/7 核销，Presidio 压至 1 天
- [路线 2 堡垒落地化方案](issues/08-route2-plan.md): Agent 回宿主机直跑，shell+fetch 执行面进 microsandbox（egress 白名单核销缺口 1），加固 Docker 降为对照基线；自写 ~100 行凭证代理全管 LLM+fetch 密钥；Presidio 接 memory.json 落库前；三实验复刻穿插；验收 = 四次主动攻击（逃逸/egress/密钥不可见/审计复盘）
- [路线 2 堡垒执行](issues/09-route2-execution.md): ✅ 已完成（2026-09-01）。microVM 执行面（shell/fetch 一次性 VM）→ 两层出网防御（工具层白名单+凭证策略 fail closed，PUBLIC profile 兜底；缺口 1 核销）→ 凭证代理（proxy.py LLM 路 + fetch 占位符路，Agent 零密钥）→ Presidio 记忆脱敏 → OTel 五要素审计（audit.who/when/why/params/data_class）→ 四次攻击验收全过（劫持无效化）→ 双复刻收官（验证沙箱选 microVM；三引擎脱敏分工拍板）；偏差与实测坑（beta 域名规则无效、gzip 透传 bug、chapter 编号误记）见票内 Answer；交付物在 `deliverables/route2/`，攻击证据在 `issues/09-route2-execution/attack-validation/`；残余：shell 公网出口、观测面凭证（归路线 3+）
- [路线 3 城堡执行](issues/11-route3-execution.md): ✅ 已完成(2026-09-02,阶段 34–46)。收敛:ContextForge 全量收编(SSE 三 server+双插件 EGRESS/FGA)+Agent/TS-client 双消费者走唯一入口;授权:OpenFGA 四元组(运维位/只读位矩阵,六 check 全中)+任务票 120s scope;闸:串联闸(D4+法官)+记忆装载三道闸+语义自检+哈希链证据;体检:毒样本 1000/1000 抓获;验收五条全过(attack-validation/ 判表);缺口 2/3/7 全销+4 接线+shell 公网出口封死(累计 7 条中 5 销 1 半 1 留);交付物 `deliverables/route3/` 三件;残余归路线 4(标定/CI/红队靶子);harness 复刻 6/13 暂停于 harness复刻/
- [路线 3 城堡落地化方案](issues/10-route3-plan.md): ContextForge 全量收编（三 server 加 streamable HTTP 挂网关，唯一入口）+ OpenFGA 真引入（四元组"能执行什么"归 FGA，原生 RBAC 团队粒度管"能看什么"；check 落自写 tool_pre_invoke 插件）+ 串联闸留本地中间件（D4+LLM 法官——会话语义在 agent 侧；两 PEP 各管各的语义）+ 审计三面（Langfuse 观测 / audit_trails 平台 / 自写哈希链锚点，data_class 升参数级）+ 自写短时令牌 + Presidio 预算转投串联闸（票 03 那条作废）+ 供应链体检扫全上游（mcp-scan 已改名 snyk-agent-scan）+ harness-safety-gate 一场全复刻 + 语言策略：主体 Py 不动，TS 以裸官方 SDK 第二消费者轻触点引入（双 agent 使授权矩阵不退化，兼作路线 4 靶子）；分工一句话：网关管身份，agent 管会话，server 管出口；研究事实底座 `issues/10-route3-plan/research-contextforge-openfga.md`；执行票 11 已开
- [路线 4 红队落地化方案](issues/12-route4-redteam-plan.md): 范围=图纸步骤 1 红队+缺口 4/5/6 核销（步骤 2 运行时监控降熟悉档：macOS 无 eBPF）；姿态=收官形态主靶+剥层对照（每次只关一层，判表带"漏到第几层"纵深语义；反向案例只作武器校准靶）；注入/外泄/多轮全量、越狱对照；garak 打薄 HTTP chat 层（发现器+语料发生器）、PyRIT 进程内编排+五条确定性 scorer（主场）、TS client=第二攻击通道（bob 越权+user_map 滥用面）；缺口 4/5 并成标定流程（标本集+阈值扫描+入 CI）、6 只实测穿透率+聚合方案（实现另开票）；garak 白名单五族；Crescendo/PAIR 全量 TAP 对照；judge=MiniMax-M2 只评分不进门槛；回归集落 `starter-agent/redteam-regression/`（种子十条）；验收六条；交付物三件 `deliverables/route4/`；新术语入 CONTEXT（剥层对照/武器校准靶/标定流程）；执行票 13 已开
- [思维导图工具选型](issues/14-mindmap-tooling.md): 主用 markmap（markdown 源直进 git 可 diff、节点原生支持本地相对链接、markmap-cli 出自包含离线 HTML、VS Code 扩展实时预览），备选 Freeplane（XML 可 diff、手动布局/打印级导出）；Mermaid mindmap 无折叠无节点链接、drawio 非文本驱动、Obsidian Canvas 白板错配层级导图，均排除
- [路线 1–3 复习方案（思维导图）](issues/15-review-plan.md): 素材不动原文件、按分类体系新建骨架（agent 搭骨架+用户逐节点复习）；四层防线为一级主轴，分支内按"攻击面→机制→实现链接→残余缺口"展开；markmap 文本驱动进 git；路线 4 方案作 ◐ 未实践分支纳入；导图兼作面试材料整合第一块；票 13 挂起待恢复

## Not yet specified

- 路线 4 熟悉档（端云隐私+推理端+运行时行为监控——步骤 2 经票 12 降档，mcp-sec-audit 三层架构与 protect-mcp 回执思想纸面入蓝图）与收尾三件（熟悉即可检验形式/面试材料整合/零信任架构蓝图）；票 11 残余"哈希链外锚+出口白名单完整版"属防线改进项，归此收尾——**均顺延至路线 5 之后**
- 缺口 6 会话级聚合闸实现（防线改动票，待票 13 红队实测穿透率+聚合判定方案文档回来后开）
- harness 复刻续作(6/13 暂停,状态在 harness复刻/MISSION.md;非主线阻塞——⑤ 审批回路已吸收其设计答案)
- 路线 5 收官后的恢复项：票 13 红队（TS 版将成为第二靶子）、RAG/多 agent 的深化（视面试反馈）

## Out of scope

- chapter8 训练侧安全（RLVP / DPO / reward hacking）：属模型后训练，不在 JD 射程内
- 合规标准（NIST AI RMF / EU AI Act）：求职被问到时再补
