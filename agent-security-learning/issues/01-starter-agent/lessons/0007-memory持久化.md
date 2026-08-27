# 阶段 7:memory.json 持久化

## 一、三问(阶段动机)

**这一阶段是干嘛的**:退出时把对话历史从 checkpointer 落盘到 `memory.json`,启动时回灌——进程重启后 Agent 还记得你。

**因为什么需求需要这么设计**:阶段 6 的 `InMemorySaver` 顾名思义:进程一关,记忆归零。规格里"可选 memory.json 持久化"补的就是这个断层。更深一层的动机:**记忆一旦持久化,就成了攻击面**——上一会话里被注入的恶意内容,这一会话还在影响 Agent("记忆投毒")。亲手实现持久化,才能讲清这个风险是怎么产生的。

**解决了什么问题**:补全规格最后一块功能面;同时留下一个明确的改造点——现在保存的是**全部**消息(含工具调用的中间产物),重启即无限增长,这是路线 1/3 做记忆裁剪和审计时的抓手。

## 二、全链路一览

```
启动: memory.json 存在?
   │ 是
   ▼
messages_from_dict() 反序列化 → agent.update_state(THREAD, {"messages": ...})
   │                                    (走 add_messages reducer 注入 checkpointer)
   ▼
对话进行中: 每轮 ask() 照常,checkpointer 在内存里累积历史
   │
   ▼
退出(/quit 或 Ctrl+C/D): agent.get_state(THREAD) 取出全部消息
   │
   ▼
messages_to_dict() 序列化 → json.dumps → memory.json
```

## 三、跟着数据走 3 步

1. **落盘**:会话一说"我叫小明"后退出,`save_memory()` 从 checkpointer 取出 2 条消息(HumanMessage + AIMessage),`messages_to_dict()` 转成 `[{"type":"human","data":{...}}, ...]` 这样的纯 JSON,写入 `memory.json`(实测 1456 字节)。
2. **恢复**:会话二是**全新进程**——LLM 客户端、checkpointer 全是新建的。`load_memory()` 读出 JSON,`messages_from_dict()` 还原成消息对象,`update_state` 注入线程。控制台打印"已从 memory.json 恢复 2 条历史消息"。
3. **生效**:问"我叫什么名字?"→ 答"你叫小明呀"。记忆跨进程存活,靠的不是模型(它永远无状态),而是这份 JSON 文件。

## 四、新技术点四要素

### 消息序列化工具(langchain-core)

- **名字**:`messages_to_dict` / `messages_from_dict`,langchain-core 的消息编解码对
- **作用**:在 BaseMessage 对象和纯 JSON 字典之间双向转换,角色/内容/工具调用元数据都保住。和手拼 `{"role": ...}` 的区别:ToolMessage、AIMessage 的 tool_calls 等结构不丢
- **参数**:输入输出都是消息列表 ↔ 字典列表,无配置项;配 `json.dumps(..., ensure_ascii=False)` 保中文可读
- **用法**:挂载点 `agent.py` `save_memory()` / `load_memory()`

### 状态读写对(LangGraph 图实例方法)

- **名字**:`graph.get_state(config)` / `graph.update_state(config, values)`
- **作用**:从外部读取/改写某个 thread 的存档状态。`update_state` 走通道 reducer(messages 通道是 add_messages=追加,不是覆盖)——**追加语义是它能用来"回灌历史"的原因**
- **参数**:都靠 config 里的 thread_id 定位线程;update_state 第二参数是 {通道名: 新值}
- **用法**:挂载点同上;这也是以后做"人工介入改状态""审计回放"的入口

## 五、关键顿悟

- **持久化=把信任域延长到磁盘**:内存里的历史进程死即焚毁;落盘之后,谁改过 memory.json、上一会话注入了什么,都会带进下一会话。路线 4 的记忆投毒实验就从"手工篡改这个 JSON"开始。
- **存全量是最懒也最诚实的起点**:现在连工具调用的中间消息都存。它正确(重放完整)但浪费(prompt 越来越长)。知道"为什么以后需要裁剪"比一上来就裁剪重要。
- **加载与保存不对称才完整**:只存不读是死数据,只读不存是断链——本阶段把两头都接上,才看到"跨进程记忆"这个完整现象。
