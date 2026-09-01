# 路线 3 城堡执行

Type: task
Status: open
Blocked by: 10

> 执行前先读:票 10 Answer(全部已定决策)+ 研究核查摘要 `issues/10-route3-plan/research-contextforge-openfga.md`(部署命令、插件模式、建模示例、密钥变量都在里面)。

## Question

按「路线 3 城堡落地化方案」（issues/10）的已定决策执行，参照量级 4–5 天（不作死线）：

1. **网关收敛 + 双身份**（约 1.5 天）：开工前重拉《Agent开发分层与语言选型》数据校验时效（半天内）；ContextForge PyPI 原生安装（先 `init_secrets` 设 JWT_SECRET_KEY/AUTH_ENCRYPTION_SECRET）；三个自写 FastMCP server 加 streamable HTTP transport 挂网关，拔直连；TS 裸官方 SDK ~百行最小 client 作第二身份（只读问答位）；per-agent 工具 ACL（virtual server + team 间接实现）；Admin UI/REST API 注册上游。
2. **细粒度授权**（约 1 天）：OpenFGA 单容器 + 内存存储；model.fga 建模（人×Agent×工具×资源，三元组级联示例见研究摘要 B3）+ 授权矩阵文档 + 真实 tuples；自写 `tool_pre_invoke` CPEX 插件调 fga check（抄 deny_filter 模式）；Zanzibar 关系元组章节精读；TS client 越权攻击验证 fail closed。
3. **串联闸 + 缺口核销**（约 1–1.5 天）：本地 `wrap_tool_call` 栈上 D4 规则 + LLM 法官 + fail-closed 审批；缺口 2/7 记忆装载校验（注入检查+来源标记+完整性校验，合并处理）；缺口 4 语义自检接线（工具返回扫描后）；哈希链证据日志（append-only，前条 hash+工具调用要素）+ `audit.data_class` 参数级映射；短时令牌服务（短时效 JWT + scope=本轮工具子集 + fail closed，从 proxy.py 演进）；Presidio 装载链路复查；deny/regex 现成插件上网关作第二道。
4. **边界验证 + 复盘**（约 1 天）：五条验收（见票 10 Answer）；供应链体检 `uvx snyk-agent-scan@latest`（SNYK_TOKEN 同密钥纪律；扫全上游 + 自制 1–2 投毒样本 server + 1 真第三方，人工复核 2–3 高危）；harness-safety-gate 全复刻（平行窗口，参照路线 2 做法）；交付物三件；本票写 Answer 关闭。

教学记录沿用 lessons 编号续排；知识卡片沿用前两关做法。

验收（`deliverables/route3/` 三件）：
1. 授权模型设计文档：授权矩阵 + model.fga + "为什么鉴权是 PEP 不是 prompt" + ContextForge RBAC/OpenFGA 分工
2. 网关收敛与攻击复盘记录：收敛证据 + 串联闸拦截 + 越权/令牌 fail closed + 审计三面对照 + 哈希链防篡改验证 + 供应链体检
3. 缺口核销记录：2/3/7 + 缺口 4 接线 + shell 公网出口；回写 `deliverables/route1/03-已知缺口清单.md`

约束：
- 改造对象唯一：`starter-agent/`（路线 2 收官形态起步）；新语言触点仅 `starter-agent/ts-client/`（裸 @modelcontextprotocol/sdk，~百行）
- 运行形态不变：Agent 宿主机直跑，shell/fetch 执行面在一次性 microVM；ContextForge/OpenFGA 宿主进程跑（compose 全栈仅对照体验）
- 教学记录编号续排：lessons 从 **0029** 起，learning-records 从 **0032** 起；知识卡片续 `知识卡片-碎片/` 现有编号；MISSION 阶段编号续 33 → **阶段 34 起**
- 文件归拢：除 `deliverables/route3/` 外，本任务产出全部放 `issues/11-route3-execution/`
- 战利品不变：假密钥 `INTERNAL_API_KEY` + `run_command` 非预期命令；真 key 只走 Keychain（`run-proxy.sh`/`run-agent.sh` 不动）；`.env` 永远假密钥
- ContextForge 迭代快（1–2 周一版）、microsandbox 是 beta：踩坑记 record，不硬撑

解决时 Answer 记录交付物位置、与方案 10 的偏差、验收证据。
