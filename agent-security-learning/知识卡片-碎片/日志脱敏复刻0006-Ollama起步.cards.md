# 日志脱敏复刻0006-Ollama起步 —— 知识卡片

### Ollama 本地模型服务器(Ollama, local model server)

是什么:Ollama 是一个跑在本机上的开源模型服务器,把"在本机跑一个大模型"简化成"调一个 HTTP 接口"——模型加载、内存/显存管理、推理全被它包进后台,对外只剩请求进、token 流出。官方定位语最近从 "Get up and running with large language models" 换成了 "Start building with open models",README 原话是 "Ollama has a REST API for running and managing models"。底层推理引擎是 llama.cpp(把大模型权重在本机 CPU/GPU 上跑起来的开源引擎)。qwen3:0.6b 是它拉到本地的一个 0.6B(约 6 亿参数)小模型——这种与调云端 API 相对的本地部署,业界通称端侧模型(on-device LLM,指模型驻留在用户设备上推理)。

权重到底住在哪:驻留的官方措辞是 "loaded into memory"——模型可整体驻留 GPU 显存、整体驻留 CPU 内存或两者混合(`ollama ps` 命令的 Processor 列直接可见);实测这台机器上 0.6B 整体进了 GPU,推理走的是 llama.cpp 的 Metal 后端(Metal 是 Apple 的 GPU 编程接口,属 llama.cpp 的 macOS 后端;Ollama 官方文档只一句带过 'via the Metal API',具体到哪层后端由实测确认)。

解决什么问题:语义类检测任务(病历描述、自然语言口令)没有稳定格式,正则永远写不出,需要"看得懂语义"的模型;可日志恰恰是最不能出门的数据——把日志发给云端模型 API,等于亲手把要保护的秘密送出门。端侧部署解开"要语义"与"要保密"的两难:模型搬到数据跟前,而不是数据去找模型,脱敏链路因此全程零外发。这与本地凭证代理(把凭据留在本机、由代理层代为取用的访问设计;已有专卡)是同一安全取向:敏感的东西不动,让计算方上门。

我们的办法:环境用 brew(Homebrew,macOS 常用的包管理器)安装 Ollama 并注册成开机常驻服务,再拉取约 500MB 的 qwen3:0.6b,调用不装官方 SDK、走原生接口加标准库。实测向 `http://127.0.0.1:11434/api/chat` POST 一条提取手机号的冒烟请求,约 2 秒拿回正确结果,数据全程不出本机。

### JSON Lines 流式响应(JSON Lines streaming)

是什么:JSON Lines 流式响应是流式接口的一种返回形态——回答不是攒齐一整块给,而是一行一行到;每行是一个独立成立的小 JSON 对象,对应模型新吐出的一小段文字(token,模型计量文本的最小单位)。Ollama 的聊天接口用请求体里的 `"stream"` 字段切换:true 逐行滚、适合边生成边看,false 攒齐一次给全。

协议细节:JSON Lines 有三条硬规则:每行必须是一个合法的 JSON 值(规范原话 "Each Line is a Valid JSON Value");编码统一 UTF-8 且不带 BOM(文件开头的字节序标记);行终止符统一是 '\n',空行不合法。最后一条直接决定逐行读流解析器的正确写法——空行不能想当然当分隔符默默跳过,按规范它是协议异常,至少要显式处理。最后一行带 `"done":true`,顺路捎上账单——总耗时、输入 token 数(`prompt_eval_count`)、输出 token 数(`eval_count`);官方还规定接口里所有时长字段的单位一律是纳秒,换算毫秒要除以一百万。账单之外还有一个 `done_reason`(结束原因字段):`stop` 是正常生成完,`load`/`unload` 则把"刚完成模型加载/模型被卸载"这种服务器内部状态直接暴露进协议——冷加载发生了没有,协议自己会招供。JSON Lines 本是给文件交换用的格式,Ollama 借它当 HTTP 响应体;云端 OpenAI 系流式用的是 SSE(Server-Sent Events,另一种逐行事件格式)而非 JSON Lines——换到云端,解析得另写。

一个会思考的模型长什么样:qwen3 这类推理模型(作答前先在内部过一遍思考)会先在 `message.thinking` 字段里滚思考过程——如"嗯,用户让我用一句话介绍自己…";正文随后到,落在 `message.content` 字段。思考与正文分字段,解析方就能只取 content、跳过思考,思考吃了多少 token 也一目了然——实测一次回答统计里输出 248 token,大头是思考。得认清"谁负责拆":Qwen3 模型自己的输出文本层,原样仍是 `<think>` 标签;是 Ollama 在 API 层把它拆进 `message.thinking` 字段——"拆思考"是推理服务的功劳,别记到模型头上。要不要拆还能由请求控制:请求体里的 `"think"` 参数(布尔或思考档位)直接开关思考。直连模型文本层时,思考就是混在正文里的标签,得靠字符串解析剥出来(同族麻烦已有"OpenAI 兼容端点"专卡);顺带的体会——协议读文档不如打一遍接口实在。

我们的办法:用标准库逐行读流,解析时跳过 thinking 只取 content,拿 done 行的统计字段当延迟与 token 指标的直接来源——空行不合法有规范背书,遇到就按异常对待。实测流式模式下三段边界清楚——思考行先滚,正文行随后,done 行收尾。

### 代码围栏包裹问题(markdown code fence wrapping)

是什么:代码围栏(markdown code fence)是 Markdown 文档里用三个反引号包住代码块的书写标记——CommonMark(Markdown 的标准化规范)给的定义:"A code fence is a sequence of at least three consecutive backtick characters (`) or tildes (~)."——至少三个连续反引号或波浪号(不可混用)。起始行反引号后面的那段文字叫 info string(围栏信息串,惯例用作语言标注,` ```json ` 里的 `json` 就是它)。放到 LLM 输出语境,它指一种反直觉的失败形态——明确要求"只输出 JSON",小模型却把 JSON 整体包进围栏、有时再添一句客套话交卷。指令的大方向跟得住,输出格式管不住——"差不多听话",但不精确服从。
实测长这样:指令是"从这句话提取手机号,只输出 JSON: {\"phone\": 号码}"。号码提对了,message.content 的原样文本却是下面这样——缩进显示,围栏是内容的一部分:

    ```json
    {"phone": "13812345678"}
    ```

解决什么问题:先点破一层——围栏是 Markdown 的语法结构,不是 JSON 的一部分,模型这么交卷等于擅自换了输出格式;解析器不认情面——对这段文本直接调 `json.loads()`(把 JSON 文本还原成程序里数据结构的标准操作)当场报错,因为首尾混进了非 JSON 字符。结构化任务的输出要进程序,格式错一点就断在解析上;指望"在提示词里更凶地求它"治不好,围栏只是格式失控的症状之一。围栏包裹也并非 0.6B 独有,同类报告在更大模型上也有。更准的说法是:模型越小,格式服从性越差——0.6B 只是把这个问题放大到必现。云端官方文档也早把"求"与"锁"分了档:OpenAI/Azure 的 `json_object` 档只敢承诺 "guaranteed valid JSON"(仅保证是合法 JSON),结构服从是 `json_schema` 档的事(官方说 JSON mode "couldn't ensure strict adherence to the supplied schema",即无法确保严格遵从所给的 schema)。

我们的办法:两条修法里选了稳的那条——让推理服务在解码层强制合法 JSON(即"结构化输出",机制另有专卡),不选自己拿字符串剥围栏;剥法赌的是模型不换花样,它哪天加一句"好的,以下是结果"就破。
