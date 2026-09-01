# 0006 — 阶段 6:Ollama 起步(端侧小模型就位,路线 4 热身)

> 本阶段零项目代码,是**环境阶段**:装 Ollama + 拉 qwen3:0.6b + 裸 `/api/chat` 冒烟。
> 装完是全局环境,路线 4 直接复用,不卸。

## 1. 三问:这一阶段是干嘛的?

**位置感**:

```
✅ 1-5 规则引擎 + 回归(全程零依赖零模型)
✅ 6 Ollama 起步   ← 你在这里(第一次碰模型)
⬜ 7 LLM 引擎(结构化输出)→ 8 回填验收 → 9 混合 → 10 campaign → 11 对照收官
```

- **干嘛的?** 把端侧推理环境立起来:Ollama(本地模型服务器)+ qwen3:0.6b(5 亿参数小模型),并用最裸的 curl 打一遍它的 HTTP API。
- **什么需求逼的?** 阶段 1 就埋了话:病历描述、自然语言口令——正则写不出,要"看得懂语义"的引擎。但安全工程不能用"把日志发给大模型 API"来解决:日志恰恰是最不能出门的数据。所以需要**数据不出门**的本地模型。
- **解决什么麻烦?** "语义检测"和"数据保密"的矛盾。端侧模型(推理发生在你自己的 Metal GPU 上)是矛盾的解:模型来找数据,不是数据去找模型——**脱敏系统的 LLM 路径也全程零外发**,和安全叙事闭环。

## 2. 全链路一览(一条请求的旅程)

```
curl POST /api/chat(127.0.0.1:11434)
      │ JSON:{"model","messages","stream"}
      ▼
Ollama 服务(brew services 托管的 launchd 常驻进程)
      │ 按需把模型加载进 Metal GPU(不跑推理时模型不占显存)
      ▼
qwen3:0.6b 逐 token 生成
      │ 每个 token 一行 JSON(流式)——message.thinking 思考 / message.content 正文
      ▼
curl 逐行收到;done:true 那行带耗时与 token 统计
```

## 3. 跟着数据走:冒烟 2(结构化小指令)的完整往返

**请求**(从终端发出):

```bash
curl -sN http://127.0.0.1:11434/api/chat -d '{
  "model": "qwen3:0.6b",
  "messages": [{"role": "user", "content": "从这句话提取手机号,只输出 JSON: {\"phone\": 号码}。句子:我的手机号是13812345678收到请回复"}],
  "stream": false
}'
```

**返回**(单行 JSON,`stream:false` 时一次给全):`message.content` 是模型回答,统计字段告诉你 `prompt 46 tok、输出 248 tok、总 1.93s`。

**回答内容**:

```json
```json
{"phone": "13812345678"}
```
```

号码**提取对了**——0.6B 的中文指令跟随能力够用。但看形状:它把 JSON 包进了 **markdown 代码围栏**(```json ... ```)。这就是本阶段最重要的体感:**小模型"差不多听话"但不精确服从**。直接 `json.loads()` 这个输出会炸。两条路修它:自己剥围栏(脆),或者让 Ollama 在解码层面强制 JSON(阶段 7 的 `format` 参数,schema 约束,稳)。**schema 不是锦上添花,是必需品。**

顺带:冒烟 1(纯聊天)暴露了 qwen3 的**思考模式**——流式 JSON 行里,先来一串 `message.thinking`(“嗯,用户让我用一句话介绍自己…"),再来 `message.content`(正式回答)。参考项目当年要靠解析文本里的 `<think>` 标签,现在 API 直接分字段了——协议在进化,读文档不如打一遍 API 实在。

## 4. 新技术点:Ollama 的 /api/chat 协议

- **名字**:Ollama Chat API(`POST http://127.0.0.1:11434/api/chat`),本地 HTTP 服务,无 SDK 也能调——本项目选 curl/标准库路线,不装 ollama Python 包(贴协议本质)。
- **作用**:把"跑一个本地大模型"简化成"调一个 HTTP 接口"。模型加载/显存管理/推理全被它包了;对你暴露的就是 messages 进、token 流出。
- **参数**(请求体):`model`(模型名)、`messages`(role/content 数组,同 OpenAI 形状)、`stream`(true=逐 token 的 JSON 行流,false=单行全量)、`format`(传 JSON Schema 可**在解码层强制**输出合法 JSON——阶段 7 主角)、`options`(temperature/seed/num_predict)。
- **用法**:响应行关键字段——`message.thinking`(思考 token,qwen3 特有)、`message.content`(正文)、`done`(最后一批为 true)、`total_duration/prompt_eval_count/eval_count`(耗时与 token 数,阶段 7 的 TTFT 指标就从这里来)。

## 5. 关键顿悟

- **0.6B 的能力画像:指令大方向跟得住,输出格式管不住。** 能提取对号码,但会给你加围栏、加客套话。结构化任务的正确姿势是**协议层约束**(format schema),不是提示词求它。
- **thinking 与 content 分字段,是"会思考的小模型"的新协议形态。** 阶段 7 解析输出时要跳过 thinking 只取 content——这也是 token 成本:思考 248 token 里大头是思考。
- **端侧的意义对安全项目比对成本项目大。** 普通应用用本地模型图省钱;脱敏系统用本地模型是因为**日志这个数据品类根本不允许出门**。

## 6. 亲手验证

环境三连(已完成,记录在此;新机器重装照抄):

```bash
brew install ollama            # 装(本次装到 0.33.0)
brew services start ollama     # launchd 托管常驻,开机自启
ollama pull qwen3:0.6b         # 拉模型,~500MB
```

冒烟(自己跑,感受流式和耗时):

```bash
ollama list                    # 应看到 qwen3:0.6b
curl -sN http://127.0.0.1:11434/api/chat -d '{"model":"qwen3:0.6b","messages":[{"role":"user","content":"用一句话介绍你自己"}],"stream":true}'
```

应看到:逐行 JSON 滚动,前面行的 `message.thinking` 有思考文字,后面 `message.content` 有正文,最后一行 `"done":true`。

捣乱实验:把请求里 `"stream":true` 改成 `"stream":false`,再加一段 `"format": {"type":"object","properties":{"phone":{"type":"string"}},"required":["phone"]}`,重发冒烟 2 的问题——应看到 content 是**纯 JSON,没有围栏**。这就是阶段 7 的主角提前登场;不想剧透也可以留到下阶段。
