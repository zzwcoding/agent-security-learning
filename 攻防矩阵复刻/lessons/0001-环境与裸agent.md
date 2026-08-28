# 0001:阶段 1 —— 环境与裸 Agent

## 一、三问(阶段动机)

- **这一阶段是干嘛的**:搭好可运行骨架——一个会单轮聊天的裸 Agent,系统提示词里藏着 SECRET_KEY,没有任何工具。
- **为什么需要这么设计**:攻防实验需要一个"有秘密可守"的主体。先把"敏感资源"立起来(SECRET_KEY 写进系统提示词),后面所有攻击才有靶子;同时把 key 供应链(Keychain → 环境变量 → 进程)一次跑通,之后每个阶段都不必再管环境。
- **解决了什么问题**:验证了 MiniMax-M2 的 OpenAI 兼容端点可用、`agent-key` 注入链路可用,给后续 14 个阶段铺平地基。

## 二、全链路一览

```
scripts/run.sh ──agent-key minimax──> Keychain 取 key
      │ 注入 LLM_API_KEY / LLM_BASE_URL / LLM_MODEL(只在进程环境,不落盘)
      ▼
demo.py ──OpenAI(api_key, base_url)──> api.minimaxi.com/v1 (MiniMax-M2)
      │  messages = [system(含 SECRET_KEY), user("介绍一下你自己")]
      ▼
打印模型回复
```

## 三、跟着数据走 3 步

1. **key 的旅程**:`agent-key minimax` 从 macOS Keychain 读出明文 → `export LLM_API_KEY=...` 只存在于 run.sh 启动的子进程环境 → OpenAI SDK 放进 `Authorization: Bearer` 头。全程不落磁盘——这和实验主题呼应:写在 `.env` 里的密钥等于送给注入攻击者看。
2. **SECRET_KEY 的位置**:它只是系统提示词里的一段文本(`demo.py:17-25`)。模型"知道"它,但此刻没有任何机制能泄露它(没有工具)或保护它(没有防御)——这正是 D1 无防御的胚胎形态。
3. **回复的形状**:MiniMax-M2 的 `message.content` 里带了 `<think>...</think>` 思考块。先记下这个观察——阶段 5 做密钥泄露判定器时,判定的是 final_text 里有没有密钥子串,思考块也在 final_text 里,不影响判定,但提醒我们"回复文本"不等于"用户可见文本"。

## 四、新技术点四要素:OpenAI 兼容客户端

- **名字**:OpenAI Chat Completions API(通过 OpenAI 兼容端点接国产模型),生态:`openai` Python 包。
- **作用**:统一接口——只要供应商提供 OpenAI 兼容端点(base_url + Bearer key),同一份代码换三个环境变量就能换模型。本实验复刻版就靠这点把参考项目的 gpt-4o-mini 换成 MiniMax-M2。
- **参数**:`OpenAI(api_key, base_url)`;`chat.completions.create(model, messages, [tools], [temperature])`,messages 是 `[{"role": ..., "content": ...}]` 列表,role 有 system/user/assistant/tool 四种。
- **用法**:见 `demo.py:29-41`;挂载点 `scripts/run.sh`(环境变量注入)。

## 五、关键顿悟

- **敏感资源先行**:攻防实验的地基不是攻击也不是防御,而是"有东西可偷"。SECRET_KEY 先进系统提示词,后面每一层防御的存在感都由它衬托。
- **key 供应链就是第一课**:Keychain → 环境变量 → HTTP 头,全程不落盘;实验要防的"泄露"和我们自己工程实践里的"泄露"是同一件事的两面。
- **兼容协议是复刻的杠杆**:参考项目依赖 `agentbook.providers` 注册表,我们 30 行内用裸 OpenAI 客户端替代——换供应商只换环境变量,不换代码。
