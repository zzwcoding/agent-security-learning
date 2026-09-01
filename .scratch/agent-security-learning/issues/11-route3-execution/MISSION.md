# MISSION:路线 3 城堡执行(票 11)

**一句话学习目标**:把路线 2 收官形态的起步 Agent 升级成"带网关的多工具服务平台"——每个工具调用可认证、可授权、可追责,亲身体验从"安全功能"到"安全体系"的分水岭;全程用 JD 的语言讲清每个设计决策(为什么鉴权是 PEP 不是 prompt、为什么网关管身份 agent 管会话 server 管出口)。

**验收标准**(票 10 Answer 五条):① 网关收敛(三 server 全流量过网关,直连拔除)② 授权生效(OpenFGA check + TS 第二 agent 越权 fail closed)③ 缺口核销(2/3/7 + 缺口 4 接线 + shell 公网出口)④ 审计三面 + 短时令牌 fail closed ⑤ 供应链体检(投毒样本被抓)。交付物 `deliverables/route3/` 三件。

**开工必读**:票 10 Answer(11 条决策)→ `issues/10-route3-plan/research-contextforge-openfga.md`(部署命令/插件模式/建模示例)。

**约束**:改造对象唯一 `starter-agent/`;TS 触点仅 `starter-agent/ts-client/`;运行形态不变(宿主机直跑 + microVM 执行面);lessons 从 0029 起,learning-records 从 0032 起;真 key 只走 Keychain,`.env` 永远假密钥;ContextForge 迭代快、microsandbox 是 beta——踩坑记 record。

**阶段路线**(编号续路线 2 的 33;对应票 11 四块任务单,颗粒度按教学步长切分):

| 阶段 | 内容 | 状态 |
|---|---|---|
| 34 | 开工包:选型数据时效校验(GitHub API 重拉)+ ContextForge 安装最小闭环(独立 venv、init_secrets、4444 起服、UI 可见) | ✅ 已完成(2026-09-01;lesson 0029,record 0032;uv 钉 3.12(系统 3.14 超 requires-python 上限);网关 v1.0.8 于 127.0.0.1:4444,实测:/health 200、/ 303→登录墙、/admin/login 200、/docs 认证后才可见;UI/Admin API 默认关闭,已在 .env 打开;选型表 10 仓重拉:量级全部未变,ContextForge 仍 1–2 周一版) |
| 35 | 三个自写 FastMCP server 加 HTTP transport,注册进网关(/admin/gateways),网关工具列表可见 | ✅ 已完成(2026-09-01;lesson 0030,record 0033;最终走 SSE 传输(8001-8003,streamable-http 被 stateless 终结会话致握手超时);连环四坑:CSRF 只豁免 Bearer/teams=null 才是管理员旁路([]和缺席都是公开级)/SSRF 拒 localhost 上游(SSRF_ALLOW_LOCALHOST=true 只放回环)/静默替换失败靠日志抓到;网关工具列表 6 个全亮,命名空间前缀 filesystem-* 等) |
| 36 | Agent 工具调用改走网关 + 拔直连(直连失败留证据)+ TS 裸 SDK 最小 client 第二身份出现 | ✅ 已完成(2026-09-01;lesson 0031,record 0034;agent.py 拔除 stdio 名单换网关单条目(streamable_http+Bearer),工具名全线切网关前缀;真 Agent 轮次端到端——LLM 经凭证代理决策 filesystem-list-dir、网关转发执行返回 workspace 清单;dummy token 401 拒=认证闸活;ts-client 约 60 行第二消费者同门跑通(6 工具+一次真调用);踩坑:shell 嵌套引号撕碎多行 python -c→独立 mint 脚本+零插值 heredoc) |
| 37 | OpenFGA 单容器部署 + model.fga 建模(人×Agent×工具×资源)+ 授权矩阵文档 + 真实 tuples(Playground 可见) | ⬜ |
| 38 | 自写 tool_pre_invoke CPEX 插件调 fga check + 越权攻击:TS client 越权被拒 fail closed | ⬜ |
| 39 | 串联闸:本地 wrap_tool_call 栈上 D4 规则 + LLM 法官 + fail-closed 审批(缺口 3 核销点) | ⬜ |
| 40 | 缺口 2/7 记忆装载校验(注入检查+来源标记+完整性,合并)+ 缺口 4 语义自检接线 | ⬜ |
| 41 | 哈希链证据日志(append-only,前条 hash+五要素)+ audit.data_class 参数级映射 | ⬜ |
| 42 | 短时令牌服务(短时效 JWT + scope=本轮工具子集 + fail closed,proxy.py 演进) | ⬜ |
| 43 | 供应链体检:uvx snyk-agent-scan 扫全上游 + 自制 1–2 投毒样本 server + 1 真第三方 + 人工复核 2–3 高危 | ⬜ |
| 44 | 五条验收攻击(网关收敛/越权/串联闸/审计三面/令牌 fail closed)全程留证据 | ⬜ |
| 45 | chapter9/harness-safety-gate 全复刻(平行窗口)+ permission-embedded-data-objects 与 small-model-codified-rules 对照讨论 | ⬜ |
| 46 | 收官:deliverables/route3/ 三件交付物 + 票 11 Answer 关闭 + route1 缺口清单回写 | ⬜ |
