# 阶段 3 · 步 3.1：llm_gateway 唯一出网口（票 0003）

> 路线图：✅ 0 骨架 → ✅ 1 入库 → ✅ 2 BM25 → 🔵 **3 向量检索（步 3.1 gateway ✅ 你在这里 / 3.2 余弦+向量检索 ⬜ / 3.3 页面对照+真 GLM ⬜）** → ⬜ 4 RRF → ⬜ 5 上下文增强 → ⬜ 6 问答闭环

## 1. 三问（阶段动机）

**这一步干嘛？** 建全项目唯一的"出网口"：所有找 LLM/embedding 模型的调用都走 `llm_gateway`，别无二门。

**为什么非要收一个口？** 三个理由，一个比一个实际：

1. **CI 不能花钱不能抖**：测试要跑一万次，每次都打真 API 又贵又慢还可能网络抖动挂测试。所以有个"确定性假后端"（fake stub）：同输入同输出、零网络。它必须和真后端**长一个样**（同接口同返回形状），业务代码才能两边通吃。
2. **换供应商只改配置**：base_url、key、模型名全走环境变量。智谱 → OpenAI → 椒图，改的都是配置不是代码。
3. **椒图接入面**：ADR 0002 预留的"阶段一收口"就是改这个 base_url 指向椒图网关——**OpenAI 兼容**是那天的门票，所以今天请求结构就必须 OpenAI 兼容。

**为什么是 embedding 先接模型？** 书 3.2 原文（chapter3.md:288）：

> "把每个词或句子转化成一串数字（称为"向量"）……让语义相近的内容转化出来的数字串也'相近'。"

这个"转化"靠的就是 embedding 模型——它不是切块模型（切块是上一幕的纯代码活），是把每张卡片变成一串数字的翻译官。

## 2. 全链路一览

```
业务代码（retrieval/qa/graph/wiki…）
   │  只许调这两个函数：chat(messages) / embed(texts)
   ▼
llm_gateway ──┬── fake stub：本地算、确定性、不要钱（CI/测试走这）
              └── 真实后端：httpx → OpenAI 兼容端点（默认智谱 GLM；改 WEKNORA_LLM_BASE_URL 即指向椒图）
```

## 3. 跟着数据走（一次 embed 调用）

1. 业务调 `embed(["猫吃鱼", "红烧肉"])` → gateway 看当前后端是谁。
2. **fake 路**：每个文本切成词 → 每个词用 SHA-256 哈希撒 8 个维度的 ±1 → 求和归一。"猫吃鱼" 和 "猫吃虾" 共享"猫/吃"两个词 → 向量方向自然近——这是**伪造的语义**，用来骗过测试；真同义（kitty→cat）fake 不会，那是真模型的本事（步 3.3 你亲手看）。
3. **真实路**：拼 OpenAI 兼容载荷 `{model: "embedding-3", input: [...]}` → `_post` 打到 `{base_url}/embeddings`，带 `Bearer $WEKNORA_LLM_API_KEY` → 拿回 2048 维向量。
4. **测试怎么测真实路**：`_post` 是唯一 HTTP 出口，测试用 `monkeypatch` 把它换成"间谍"——断言发出去的 URL 是 `http://localhost:9000/chat/completions`（改环境变量后），一行网络都没碰（`test_gateway_base_url_configurable`）。

## 4. 新技术点四要素

### pytest 的 monkeypatch——测试替身注入

- **名字**：`monkeypatch`，pytest 内置 fixture。
- **作用**：测试期间临时换掉一个函数/环境变量，跑完自动还原。比喻：**拍戏用的替身演员**——危险镜头（真打 HTTP）让替身上，拍完正主回来，片场恢复原样。
- **用法**：`monkeypatch.setattr(llm_gateway, "_post", spy_post)`（换函数）；`monkeypatch.setenv(...)`（换环境变量）。本项目用在 `tests/test_llm_gateway.py`。
- **为什么测 fake 还不够**：fake 证明"形状对"，但证明不了"真实路拼的 URL 对"。把 HTTP 出口设计成单点 `_post`，就是为了能在这里安插间谍。

### httpx（HTTP 客户端）

- **名字**：httpx，现代 Python HTTP 库（requests 的精神续作）。
- **作用**：替我们干"发 POST、带 header、超时控制、解析 JSON"的体力活。
- **用法**：`httpx.post(url, json=payload, headers={...}, timeout=60)` → `.raise_for_status()` → `.json()`。本项目唯一用处在 `llm_gateway._post`——全项目只有这一处碰网络。

## 5. 关键顿悟

- **"唯一出网口"是安全设计不是代码洁癖**：key 管理、计量、切换、未来的椒图收口，全压在这一个模块。业务代码想绕过它直连厂商？边界规则第 1 条 + CI 边界闸会拦。
- **fake stub 的语义是"借"来的**：词重叠→向量近，这是拿 BM25 的词袋直觉伪造稠密向量。测试用它验证"形状与排序逻辑"，真语义验证留给真模型（步 3.3）——测试替身与生产实现的能力差异要心里有数。
- **配置读取时机 = 调用时**：`_cfg()` 每次调用现读环境变量，而不是 import 时读死——这样测试中途改 env 也生效，椒图接入那天改完就灵。

## 6. 亲手验证

```bash
cd /Users/divh/Downloads/安全评估agent/weknora复刻
.venv/bin/python -m pytest tests/test_llm_gateway.py -v
```

应看到 4 个 PASS：确定性 / 批量形状 3×2048 / 词重叠语义 / base_url 可配（默认智谱→改指 localhost:9000）。

**捣乱实验**：`.venv/bin/python -c "import llm_gateway; print(llm_gateway.chat([{'role':'user','content':'hi'}]))"`——不设 key 直接打真实路，应看到 httpx 的 401 报错（智谱说"没钥匙"）。这验证了：出网只有这一个口，且没 key 真出不去。
