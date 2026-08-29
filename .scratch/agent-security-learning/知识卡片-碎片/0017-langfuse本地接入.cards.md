# 0017 langfuse本地接入 —— 知识卡片

来源:`issues/07-route1-execution/lessons/0017-langfuse本地接入.md`

### Docker Compose 多容器编排(Docker Compose)

**是什么**:Docker 官方的多容器编排工具——一个 yml 声明"要哪几个容器、各自镜像、谁等谁先起(healthcheck)、端口映射、数据存哪",一条 `docker compose up -d` 全部拉起;比手写 N 条 `docker run` 强在依赖顺序和生命周期(一起起、一起停)被声明式管理。
**解决什么问题**:Langfuse 本体不是 pip 包,是 7 个容器的数据平台(web/worker/postgres/clickhouse/redis/minio);观测平台是"一套系统",手工管不现实。
**我们的办法**:官方 v4 `docker-compose.yml` 原样下载不改,`.env` 只动四处——关遥测 `TELEMETRY_ENABLED=false`(攻防录像不发官方服务器)+ 三个标了 CHANGEME 的加密密钥换随机值(本地实例用默认值等于全网共用一把锁);起服务前 `lsof -nP -i:<端口>` 查全部 8 个端口再点火。常用命令:`up -d` / `ps` / `logs -f <服务>` / `down`(`-v` 连数据卷删,慎用)。

### 观测数据自托管(Self-Hosted Observability)

**是什么**:把 Langfuse 整套平台跑在本机 Docker 里,trace 数据不出本机——而不是发给 Langfuse 官方 SaaS。
**解决什么问题**:观测数据本身就是敏感资产:trace 里有用户输入、工具返回、甚至假密钥;发去 SaaS 等于把"攻防演练全程录像"存在别人家服务器,真实安全项目里常常是合规红线。
**我们的办法**:选自托管,代价是自己维护 7 个容器;收益是数据不出本机、能随便折腾(masking、删库重来)。配套动作:关遥测上报 + 换掉 compose 里所有 CHANGEME 默认密钥。

### LangChain 回调处理器旁路观测(LangChain CallbackHandler)

**是什么**:LangChain/LangGraph 执行链上埋了一圈"广播喇叭":每次模型调用前后、工具调用前后向注册的 listener 喊话;Langfuse 的 `langfuse.langchain.CallbackHandler` 就是个听众——**听广播,不参与决策**。对比中间件(`wrap_tool_call`):中间件是流水线上有拦停权的工人,callback 是玻璃窗外做记录的观察员,拦不了也改不了,所以接了它业务行为零变化。
**解决什么问题**:给防御系统装"监控录像"——护栏只会在终端打一行"🛡️ 拦截",攻击者试了 100 次哪次差点漏、模型为什么突然调危险工具,终端滚屏冲没后全是黑盒。
**我们的办法**:`agent.py` 里 `CallbackHandler()` 无参创建(key 和地址全从 `LANGFUSE_PUBLIC_KEY/SECRET_KEY/BASE_URL` 环境变量读),任何 LangGraph 调用的 config 里加 `"callbacks": [handler]`;SDK 后台攒批自动上报,接入只动 5 行、防御逻辑零改动。实测一次问答产生 7 个 observation(1 根 chain + 2 generation + 1 tool + 2 编排 chain),trace 是树不是流水账,父子靠 run_id 维系。

### Trace/Span/Observation 数据模型(OTel GenAI 语义约定)

**是什么**:Langfuse 的数据模型——Trace(一次问答的案卷)/ Span(案卷里按时间贴的纸条)/ Observation(Langfuse 对 span 的叫法)。v4 底层直接用 OpenTelemetry(OTel)建模;OTel 有 GenAI 语义约定(semantic conventions),规定一次 LLM 调用该记哪些字段(`gen_ai.system`、`gen_ai.request.model`、token 用量等),Langfuse 的 observation 类型(generation/span/tool/guardrail)就是它的产品化。
**解决什么问题**:行业标准而非厂商自创——跨系统对 trace(路线 3 审计)时大家讲同一套黑话才对得上账。
**我们的办法**:手动补录用 `client.start_as_current_observation(as_type="guardrail", input=..., level="WARNING", metadata={分数})` 上下文管理器,出块自动结束并计时;`client.flush()` 强制立即上报(默认攒批,交互式 CLI 里攻击现场等不起)。注意 v4 默认 `events_only` 模型,旧读接口 `GET /api/public/traces` 已 410,要查 `/api/public/v2/observations`——SDK 与服务端大版本要配对看兼容矩阵。

### 观测盲区与拦截补录(Guardrail Span Manual Logging)

**是什么**:一种观测补洞方法——安全系统里最危险的不是报错是沉默:输入护栏拦截的攻击**根本没进图**,CallbackHandler 的自动摄像头对此完全无感,Langfuse 大屏岁月静好、攻击者已敲过一次门。拦截成功本身必须留档,图外事件要手动补录。
**为什么重要**:没有补录,回归测试说"全拦住了"就没有证据;事后复盘也无法把"被拦的尝试"和"放进来的问答"放同一列表对照。
**我们怎么用**:`agent.py` 拦截分支手动开 span(`as_type="guardrail"`):输入原文、判决"未进入 ReAct 图"、`level=WARNING`(UI 黄色,与正常绿色 trace 一眼区分)、metadata 塞注入分数,然后 `flush()` 立即上报。实测两行 payload 各留一条 `input-guard-block` WARNING 记录,与终端拦截日志一一对应。自动(CallbackHandler 管图内每步)与手动(`get_client()` 管图外一事)是同一支笔的两头,汇进同一 trace 仓库。

### Langfuse 客户端掩码函数(Mask Function)

**是什么**:`Langfuse` 客户端构造参数 `mask`(协议类型 `langfuse.types.MaskFunction`)——数据**离开本进程之前**的最后一道闸:SDK 每次上报字段(input/output/metadata)先丢给 mask 函数,它返回什么服务器就存什么,明文永不落观测库。与输出护栏分工:护栏管"模型不该说的话",mask 管"监控系统不该存的话",互不替代。
**解决什么问题**:观测面也是攻击面——trace 里有密钥原文,观测库就成了新的泄露点。mask 在客户端执行,本质区别于"事后在数据库删数据":后者明文已落过盘,窗口期就是事故期。
**我们的办法**:正则匹配 `key|secret|token|password` 后跟 `=`/`:` 的键值对,递归处理字符串/字典/列表替换成 `***`;挂法有讲究——**CallbackHandler 自己没有 mask 参数**,必须先 `Langfuse(mask=mask_secrets)` 显式建客户端注册进实例表,后建的 handler 内部 `get_client()` 重建时逐字段继承(读源码确认)。实测嵌 `INTERNAL_API_KEY=ik-live-...` 的被拦 payload 补录后直查 ClickHouse,密钥已是 `***`,明文没出库。意外收获:验证时发现工具返回护栏先把带密钥的内容拦了——护栏顺带保护了观测系统,观测与防御互为镜子。
