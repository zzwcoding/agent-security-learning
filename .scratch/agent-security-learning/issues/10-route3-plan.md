# 路线 3 城堡落地化方案

Type: grilling
Status: resolved
Blocked by:

## Answer（2026-09-01，两轮 grilling 后用户按推荐全部确认）

**事实底座**:开工前研究子代理核查了 ContextForge/OpenFGA/mcp-scan 的落地细节,摘要存 `issues/10-route3-plan/research-contextforge-openfga.md`(部署命令、RBAC 粒度上限、CPEX 插件模式、审计表字段、OpenFGA 建模示例、mcp-scan 改名)。以下决策已吸收这些事实。

**形态级决策(第一轮 8 条)**:

1. **网关全量收编**:三个自写 server 全部注册进 ContextForge,Agent 所有工具调用改经网关,直连路径拔除;网关成为唯一入口。落点细化(研究核实):上游只收 SSE/streamable HTTP——FastMCP 三 server 直接加 streamable HTTP transport,不走 translate 桥接;shell/fetch 的 microVM 执行面不变(VM 在 server 内部,对网关透明,无官方集成也不需要)。
2. **OpenFGA 真引入**:Mac 单容器 + 内存存储(原生 arm64,教学够用,tuples 重建脚本化);`openfga_sdk` 接线;Zanzibar 只精读关系元组核心章节(图纸原文)。
3. **缺口 4 只接语义自检**(工具返回扫描后接线,NeMo 窗口已验证可拦);缺口 6 会话级聚合判定留路线 4。
4. **审计双轨 → 三面**(研究核实后细化):Langfuse=agent 侧观测(OTel 五要素);ContextForge `audit_trails` 表=网关侧平台审计(自带 `/api/logs/*` 查询与 `data_classification` 字段);**自写哈希链证据日志**=独立 append-only 锚点(每条含前条 hash + 工具调用要素,可验篡改)。`audit.data_class` 升参数级(参数映射表)。
5. **任务级短时令牌**:自写最小 token 服务(从 proxy.py 演进):短时效 JWT + scope=本轮任务允许的工具子集 + LLM 零接触 + 过期/超范围 fail closed。
6. **Presidio 不再单排**:票 03"Presidio 压至 1 天"作废(阶段 28 已端到端落地),预算转投串联闸+LLM 法官;路线 3 只做装载链路复查。
7. **供应链体检扫全上游**:三个自写 server + 自制 1–2 个投毒/诱导样本 server + 接入 1 个真第三方,人工复核 2–3 高危;投毒样本进路线 4 CI 回归种子。**工具改名**:mcp-scan 已被 Snyk 收购为 `snyk-agent-scan`(PyPI mcp-scan 是 stub),用 `uvx snyk-agent-scan@latest` + SNYK_TOKEN。
8. **复刻落位**:harness-safety-gate 一场全复刻(审批门最完整实现,与串联闸同域,平行窗口);permission-embedded-data-objects 与 small-model-codified-rules 对照讨论不落地(各一 lesson);证据链四件套横切参照。

**语言与落点决策(第二轮 3 条)**:

9. **语言策略**:主体 Python 不动(starter-agent 全部安全资产延续);TS 以"第二消费者"轻触点引入——裸 `@modelcontextprotocol/sdk` ~百行最小 agent,作第二个身份(只读问答位)消费网关;Vercel AI SDK/Mastra 只作 JD 谈资不实操;TS client 兼作路线 4 红队靶子。**双 agent 让授权矩阵的 Agent 维不退化**(运维位 vs 只读位,per-agent RBAC 有真对比)。设计原则(《Agent开发分层与语言选型》§3):分层靠协议解耦不靠语言换位;重资产=部署+精读,亲手写=**锚点件**(串联闸、哈希链、token 服务、OpenFGA 模型+矩阵文档、TS client、FGA-check 插件)。
10. **授权 PEP 落网关插件,串联闸落本地中间件——两个 PEP 各管各的语义**:OpenFGA check 以自写 `tool_pre_invoke` CPEX 插件落网关(身份/授权语义,抄 deny_filter 模式);串联闸(缺口 3)留本地 `wrap_tool_call` 栈——D4 规则要读"本轮用户消息",会话语义在 agent 侧,网关是会话无关的策略点;路线 2 中间件骨架直接续用。分工一句话:**网关管身份,agent 管会话,server 管出口**。
11. **RBAC 分工**(研究核实的粒度边界):ContextForge 原生管"能看什么"(团队可见性+类别级权限+virtual server 工具子集,无 per-tool grant);四元组细粒度"能执行什么"归 OpenFGA。

**egress 分工(既定项)**:调用方授权(per-agent 工具 ACL,经 virtual server+team 间接实现)上移网关,启用其自带 SSRF 防护;出口域名白名单+凭证策略留守 fetch_server(路线 2 实战验证过 fail closed,贴着 VM 兜底);VM PUBLIC profile 兜底不变;shell 公网出口残余由"低权 agent 无 shell + 网关命令过滤插件"核销。**缺口 2/7 记忆装载校验**落本地装载链路(注入检查+来源标记+完整性校验,合并处理;NeMo 对账已证装载在护栏链路外)。

**验收(五条)**:
1. 网关收敛:三 server 全流量过网关,直连路径拔除(证据:直连失败 + 网关审计可见全流量)
2. 授权生效:OpenFGA check 落地;TS 第二 agent 越权调用被拒 fail closed;运维位合法调用放行
3. 核销:缺口 2/3/7 全销 + 缺口 4 语义自检接线 + shell 公网出口封死
4. 审计三面 + 令牌:攻击全程 Langfuse 五要素可查、`audit_trails` 可查、哈希链可验篡改(篡改一条能被验出);短时令牌过期/超范围 fail closed
5. 供应链体检:snyk-agent-scan 扫全上游,自制投毒样本被抓,人工复核记录 2–3 条,样本进路线 4 回归种子

**交付物(`deliverables/route3/` 三件,格式照抄前两关)**:
1. 授权模型设计文档:授权矩阵(人×Agent×工具×资源)+ model.fga + "为什么鉴权是 PEP 不是 prompt" + ContextForge RBAC/OpenFGA 分工
2. 网关收敛与攻击复盘记录:收敛证据 + 串联闸拦截 + 越权/令牌 fail closed + 审计三面对照 + 哈希链防篡改验证 + 供应链体检报告
3. 缺口核销记录:2/3/7 + 缺口 4 接线 + shell 公网出口;回写 `deliverables/route1/03-已知缺口清单.md`

**与既有决策的偏差**:票 03 排期中"Presidio 压至 1 天"作废(第 6 条);图纸步骤 2 "哈希链嵌网关"改为独立锚点件(第 4/10 条,锚点件清单为准);票 06 中 mcp-scan CLI 的调用名更新为 snyk-agent-scan(第 7 条,收购改名非改选型)。《Agent开发分层与语言选型》§4 检查清单(重拉数据校验时效等)移交执行票。

## Question

图纸路线 3（细粒度授权 → MCP 网关与审计 → 任务级短时令牌 → MCP 供应链体检）如何落在起步 Agent 上。参照路线 1/2 惯例：方案票只定决策（建什么、用什么、验收什么），执行票另开。

待摊开的决策点（开工时按此 grill）：

- 网关接入形态：IBM mcp-context-forge（票 05 已定选型）怎么接——现有 filesystem/shell/fetch 三个自写 MCP server 是否收进网关后面、Agent 调用路径怎么改；路线 2 的工具层 egress 白名单与凭证策略是否上移网关层（顺带核销 shell 公网出口残余）
- 细粒度授权：OpenFGA 引入深度（部署建模跑通即可 vs 精读 Zanzibar）；授权矩阵（人 × Agent × 工具 × 资源）怎么设计；鉴权作为 policy enforcement point 落在哪一层
- 缺口核销验收：缺口 2（记忆装载校验）/ 3（执行串联闸）/ 7（毒源合并处理）怎么落（备料方案已在缺口清单）；缺口 4/6 的路线 3 部分（语义自检接线、会话级判定）做不做
- 审计关系：哈希链日志（自写几十行）与路线 2 已有的 OTel 五要素审计（Langfuse）怎么分工/叠放；audit.data_class 参数级分级是否本关做
- 任务级短时令牌：arcade-ai/Keycard 借鉴后自实现的最小版本形态（路线 2 凭证代理怎么演进）
- Presidio 去留：已在路线 2 落地（阶段 28，memory.json 落库前），票 03 排期里「Presidio 压至 1 天」是否还成立、腾出的预算给谁
- MCP 供应链体检：mcp-scan 扫什么对象（自写三 server？接入的第三方？）；路线 4 的 A.I.G mcp-scan 分工边界（票 06 已定 A.I.G 只取 mcp-scan CLI）

输入依赖（已备好）：

- 图纸第六节路线 3 原文（`LLM-Agent安全学习路线规划.md`）
- 网关选型结论：票 05 Answer（IBM mcp-context-forge）
- 缺口清单及备料方案：`deliverables/route1/03-已知缺口清单.md` 第 2/3/7 条；路线 2 残余归属见票 09 Answer（shell 公网出口归网关 per-agent 策略、观测面凭证收口=上报走代理、audit.data_class 静态映射归本关）
- 根目录两份长期调研：《Agent开发分层与语言选型》《沙箱机制与传统安全业务选型调研》
- 路线 3 实验素材候选（票 03）：chapter5/permission-embedded-data-objects、chapter5/small-model-codified-rules、chapter9/harness-safety-gate；证据链四件套作横切参照
- 起步 Agent 现状：路线 2 收官形态（microVM 执行面 + 凭证代理 + Presidio 记忆脱敏 + OTel 审计，见票 09 Answer 与 `deliverables/route2/`）
