# 阶段 19:Langfuse 本地接入——给 agent 装监控摄像头

> 学习项目:`starter-agent/`(LangGraph ReAct + 3 个 MCP server + 三层护栏 + 容器加固)
> 本阶段 lesson 随子阶段滚动补写:19.1 起服务 → 19.2 接入 → 19.3 拦截上 trace → 19.4 掩码

## 你在这里

终极目标:攻击 → 护栏 → 容器加固都做过之后,**亲眼看见**每一次攻防到底发生了什么——
没有观测,前面的护栏只是"日志里说拦了",谁拦的、拦在哪一步、漏了什么,全是黑盒。

```
✅ 9-11 攻击演练      ✅ 12-14 三层护栏      ✅ 15 容器加固
✅ 16-18 精读对照     ⬅ 19 Langfuse 观测(你在这里)   ⬜ 20 收官回归
```

## 一、三问(阶段动机)

**这一阶段是干嘛的?**
给 starter-agent 接一套本地 Langfuse,让"用户问 → 模型想 → 工具跑 → 护栏拦"
的每一步都留下可回放的录像(trace),包括攻击被拦截这件事本身。

**什么需求逼我们这么设计?**
阶段 12-14 的护栏只会在终端打一行 `🛡️ 拦截`。问题来了:
- 攻击者试了 100 次,哪几次差点漏过去?终端滚屏早就冲没了。
- 模型为什么突然调了 `run_command("touch PWNED")`?中间那步推理长什么样?
- 回归测试说"全拦住了",证据呢?

保安室光有门卫不行,还得有**监控录像**:事后能倒带、能逐帧看、能当证据。
Langfuse 就是这套录像系统——只看不动手,录下来给人复盘。

**它解决了什么麻烦?**
终端日志是"一次性流水",trace 是"结构化档案":每次问答是一宗案卷(trace),
案卷里按时间贴着每张纸条(span):这张是模型思考、那张是工具调用、
还有一张写着"输入护栏在此拦截,分数 0.99"。案卷能搜、能筛、能对比。

## 二、全链路一览(19.1 起完服务后的形态)

```
你的终端                     Langfuse 平台(本机 Docker,7 个容器)
┌──────────────────┐        ┌─────────────────────────────────┐
│ scripts/run-with- │        │ langfuse-web   :3000  回放大屏   │
│  keychain.sh      │        │ langfuse-worker:3030  后台整理录像│
│  └ python agent.py│        │ postgres        案卷索引(账号/项目)│
│    └ 摄像头        │─HTTP─▶ │ clickhouse      录像带仓库(海量 span)│
│   (19.2 才装)     │  上报  │ redis           快递分拣队列      │
└──────────────────┘        │ minio           大件储物间(长文本/媒体)│
                            └─────────────────────────────────┘
```

各环节大白话:
- **langfuse-web**:你浏览器打开的那个界面,看 trace、建项目、发钥匙(API key)。
- **langfuse-worker**:后台干活的——agent 上报的原始事件先丢进队列,由它分拣入库。
- **postgres**:管"谁是谁"——账号、项目、API key 这些元数据。
- **clickhouse**:管"录像带"——span/trace 这种海量明细,列式数据库查得快。
- **redis**:上报事件的中转队列,agent 发完就走,不阻塞对话。
- **minio**:存太大的字段(超长工具返回、媒体文件),clickhouse 里只留指针。

## 三、19.1 做了什么(起服务,零代码)

1. 官方 `docker-compose.yml`(Langfuse v4)原样下载到 `langfuse/`,一行没改;
   配套 `.env` 只改了四处:关掉遥测上报(`TELEMETRY_ENABLED=false`,
   安全项目的观测数据不往官方服务器发),三个加密相关的密钥换成随机值
   (官方文件里标了 CHANGEME 的占位符,本地实例用默认值等于全网共用一把锁)。
2. 起服务前按惯例 `lsof -nP -i:<端口>` 查了全部 8 个端口(3000/3030/5432/6379/8123/9000/9090/9091),全空闲。
3. `docker compose up -d` 拉起 7 个容器。
4. 浏览器开 `http://localhost:3000` → 注册账号 → 建项目 → 拿到一对 key:
   - **public key**(`pk-lf-...`):像门牌号,标明"录像存哪个项目",可以出现在客户端代码里;
   - **secret key**(`sk-lf-...`):像钥匙串的管理员钥匙,配 public 一起才有写入权限,**绝不进代码**。

## 四、新技术点四要素

### docker compose(本阶段唯一"新"工具,其实前面用过)

- **名字**:Docker Compose,Docker 官方的多容器编排工具
- **作用**:一个 yml 文件描述"我要哪几个容器、各自什么镜像、谁等谁先起、端口怎么映射、数据存哪",
  一条 `docker compose up -d` 全部拉起。比手写七条 `docker run` 强在:依赖顺序(healthcheck)
  和生命周期(一起起、一起停)被声明式管理。
- **关键命令**:
  - `docker compose up -d` 后台拉起全部服务(首次自动拉镜像)
  - `docker compose ps` 看每个容器健康状态
  - `docker compose logs -f langfuse-web` 盯某个服务的日志
  - `docker compose down` 全停(加 `-v` 连数据卷一起删,慎用)
- **本项目用在哪**:`issues/07-route1-execution/langfuse/docker-compose.yml`

### 自托管 vs SaaS(选型思考,不是 API)

观测数据本身就是敏感资产:trace 里有用户输入、工具返回、甚至假密钥。
发去 SaaS 等于把"攻防演练全程录像"存在别人家服务器——学习项目无所谓,
真实安全项目里这常常是合规红线。自托管的代价是自己维护 7 个容器;
收益是数据不出本机,还能随便折腾(masking、删库重来)。本阶段选自托管,
这也正是 handoff 指定的做法。

## 五、关键顿悟(19.1 部分)

- **观测平台是"一套系统"不是一个库**:Langfuse 本体是 7 个容器的数据平台,
  Python 包只是它发给你的摄像头。别把它想成 pip install 就完事的东西。
- **起多容器服务前,先查端口再点火**:8 个端口有一个被占就是玄学报错,
  `lsof -nP -i:<端口>` 三秒钟的事,比事后排查便宜得多。
- **本地实例也要换掉默认密钥**:compose 里的 CHANGEME 占位符是全网公开值,
  哪怕只跑在 localhost,养成"下载的 compose 先换密钥"的肌肉记忆。

---

## 六、19.2:CallbackHandler 挂进调用链(摄像头上岗)

### 新技术点四要素:LangChain Callback(回调)

- **名字**:LangChain Callback Handler(回调处理器);Langfuse 提供的实现叫
  `langfuse.langchain.CallbackHandler`(langfuse 包,Python SDK v4)
- **作用**:LangChain/LangGraph 在执行链上埋了一圈"广播喇叭":每次模型调用前后、
  每次工具调用前后,都会向注册过的 listener 喊话("我要开始调模型了,输入是这个"
  "工具回来了,结果是那个")。摄像头就是个听众——**听广播,不参与决策**。
  和已会的东西对比:中间件(`wrap_tool_call`)是站在流水线上、手里有拦停权的工人;
  callback 是趴在玻璃窗外做记录的观察员,拦不了也改不了,所以**接了它业务行为零变化**。
- **参数**:`CallbackHandler()` 无必填参——public/secret key、实例地址全部从
  `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` / `LANGFUSE_BASE_URL` 环境变量读
  (由 `scripts/run-with-keychain.sh` 从 Keychain 注入)。挂载方式:任何 LangGraph
  调用的 config 里加 `"callbacks": [handler]`。
- **用法**(本项目 `agent.py`):

```python
langfuse_handler = CallbackHandler()                      # main() 里建一个,全程复用
config = {**THREAD, "callbacks": [langfuse_handler]}      # ask() 里:和 thread 配置合并
agent.astream({"messages": [HumanMessage(text)]}, config=config, ...)
```

  挂上之后不用写任何上报代码——SDK 在后台攒批、自动发、进程退出时自动 flush。

### 跟着数据走:一句"workspace 里有哪些文件"的旅程

```
你 > "workspace 里有哪些文件"
  │
  ├─ 输入护栏扫描(分数 0.0,放行)——此时尚未进图,trace 里还什么都没有
  │
  └─ astream 启动,LangGraph 开跑,摄像头开始录像
       │
       ① [CHAIN] LangGraph 开案:trace 的档案夹建立
       │
       ② [CHAIN] model → [GENERATION] ChatOpenAI
       │   模型看到 system prompt + 你的问题,决定:"调 list_dir"
       │   span 里记下:完整输入消息、输出的 tool_calls JSON、耗时 1.2s、token 数
       │
       ③ [CHAIN] tools → [TOOL] list_dir({"path": "."})
       │   工具真跑,返回 4 个文件名(含 .env);span 里记下参数和返回原文
       │   ⚠️ 注意:工具返回护栏也在这里过了手(无注入,放行)——但护栏是中间件,
       │      不是链上的节点,trace 里默认看不到它干了什么(19.3 要补的洞)
       │
       ④ [CHAIN] model → [GENERATION] ChatOpenAI
       │   模型拿到工具返回,生成最终中文回答;输出护栏扫描(无敏感,放行)
       │
       └─ 摄像头把 7 张纸条(span)打包 → HTTP POST 到 localhost:3000
          → worker 分拣 → clickhouse 落库 → UI 回放
```

实测 trace(API 核对):1 个 LangGraph 根 chain + 2 次 ChatOpenAI generation +
1 次 list_dir tool + 2 个编排 chain = 7 个 observation,和上面一一对应。

### 踩坑记录:v4 的旧 API 被拆了

服务端 v4(我们装的 4.24.0)默认 `events_only` 数据模型,**旧版读接口
`GET /api/public/traces` 直接 410 不可用**,要查数据得用新的
`GET /api/public/v2/observations`。教训:SDK 和服务端大版本要配对看
([官方兼容矩阵](https://langfuse.com/docs/compatibility)),
排查"数据没到"之前先确认"查询的姿势对不对"。

### 19.2 顿悟

- **旁路观测的关键是"接口在框架里早就留好了"**:LangChain 的 callback 机制
  是框架原生扩展点,Langfuse 只是实现了一个听众。改 config 不改图,
  这就是为什么"接入只动了 5 行、防御逻辑零改动"。
- **trace 是树,不是流水账**:根 chain 套 model chain 套 generation/tool,
  父子关系靠 run_id 维系——UI 里那棵缩进树就是这么来的。

---

> 以下部分随 19.3/19.4 完成后补写:捣乱输入走一遍(拦截如何上 trace)、
> trace/span 与 OTel GenAI 语义约定、masking、收尾顿悟。
