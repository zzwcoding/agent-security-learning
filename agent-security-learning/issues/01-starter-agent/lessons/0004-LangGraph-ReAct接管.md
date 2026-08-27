# 阶段 4:LangGraph ReAct 接管工具调用

## 一、三问(阶段动机)

**这一阶段是干嘛的**:把"什么时候调工具、调哪个、参数填什么"的决定权从你的手(`/call`)交给 LLM——自然语言进,ReAct 循环跑,工具被模型自主调用。

**因为什么需求需要这么设计**:阶段 3 已经证明协议链路是通的,但那是"人当模型"。真实 Agent 的形态是:模型看到工具清单(schema)→ 推理要不要用 → 生成调用 JSON → 执行结果回喂 → 继续推理,直到能回答。这个"思考-行动-观察"循环就是 ReAct,它是后面一切攻击面(提示注入诱导调工具、恶意工具返回污染推理)的舞台。

**解决了什么问题**:把阶段 2(只会聊天)和阶段 3(只会手动调工具)粘成一个自主系统;工具调用的输入/输出打印在控制台,循环的每一步都可见。

## 二、全链路一览

```
你: "读一下 notes.txt"
   │
   ▼
create_agent 组装的 LangGraph 图(ReAct 循环)
   │
   ├──► LLM 节点:messages + 工具schema → 模型输出 AIMessage(tool_calls)
   │         │                                    "我要调 read_file,参数 {...}"
   │         ▼
   ├──► 工具节点:langchain-mcp-adapters 把调用翻译成 MCP 请求
   │         │      → 拉起 filesystem server 子进程 → 执行 → ToolMessage(结果)
   │         ▼
   └──► 回到 LLM 节点(结果回喂)…… 直到模型输出纯文本回答 → 循环结束
   │
   ▼
ask() 沿途流式打印: 工具调用 > read_file(...) / 工具返回 > ... / Agent > 最终回答
```

## 三、跟着数据走 4 步

以实测的"把 notes.txt 的内容改成:今天学了 ReAct 循环。"为例:

1. **决策**:模型收到 messages + 三个工具的 schema,输出一条带 `tool_calls` 的 AIMessage。控制台打印 `工具调用 > write_file({"path": "notes.txt", "content": "今天学了 ReAct 循环。"})`——**这行 JSON 是模型生成的,不是人写的**。对照阶段 3:你手动敲的 `/call write_file {...}`,现在由模型生成。
2. **执行**:LangGraph 的工具节点取出 tool_calls,langchain-mcp-adapters 把它翻译成 MCP `call_tool` 请求发给子进程,拿到的 ToolMessage 打印为 `工具返回 > 已写入 notes.txt(14 字符)`。
3. **回喂**:ToolMessage 追加进 messages,再次进 LLM 节点;模型看到"写入成功",判断任务完成,输出纯文本 AIMessage,循环终止。
4. **落盘证据**:`cat workspace/notes.txt` 显示内容真的变了——agent 的动作有真实副作用,这正是它既强大又危险的原因。

## 四、新技术点四要素

### create_agent(LangChain 的 ReAct 图工厂)

- **名字**:`langchain.agents.create_agent`(v1.0 起;旧名 `langgraph.prebuilt.create_react_agent`,已弃用、V2.0 将移除)
- **作用**:一行组装出"LLM 节点 ⇄ 工具节点"的 LangGraph 循环图;和手撸 LangGraph 节点/边的区别:标准 ReAct 不用自己布线,以后要定制(加审计节点、加护栏)才需要展开成显式图
- **参数**:`create_agent(model, tools)`;常用还有 `prompt`(系统提示,也可靠消息列表里放 SystemMessage)、`checkpointer`(阶段 6 的对话历史靠它)。返回值是编译好的图,`astream/ainvoke` 驱动
- **用法**:挂载点 `agent.py` `build_agent()`;`agent.astream({"messages": [...]}, stream_mode="values")` 逐步出全量状态

### MultiServerMCPClient(langchain-mcp-adapters)

- **名字**:`langchain_mcp_adapters.client.MultiServerMCPClient`,v0.3.2
- **作用**:把若干 MCP server 的工具聚合成 LangChain Tool 列表,并负责"调用时把 LangChain 调用翻译成 MCP 请求"。和阶段 3 裸 `ClientSession` 的关系:它就是裸 client 的批量封装+类型桥
- **参数**:构造参数是 server 字典 `{名字: {command, args, transport}}`;`get_tools()` 拉起所有 server 握手并收集 schema。注意它**每次调用才拉起 server 子进程**,不是长连接
- **用法**:挂载点 `agent.py` `MCP_SERVERS` + `build_agent()`;阶段 5 加 shell/fetch 就是往这个字典里加条目

## 五、关键顿悟

- **tool_calls 是"意图"不是"动作"**:模型只生成"我想这么调"的 JSON,真正执行的是框架。中间这道翻译层就是天然的政策检查点——路线 1 的护栏会挂在这里。
- **消息列表就是循环的全部状态**:ReAct 没有隐藏状态,`stream_mode="values"` 看到的 messages 数组就是一切。调试 agent 行为 = 读消息列表。
- **弃用警告值得当场处理**:`create_react_agent` 迁居 `langchain.agents` 是装包时警告逼出来的修正;顺版本迁移的成本是一行 import,欠债到 V2.0 就是事故。
