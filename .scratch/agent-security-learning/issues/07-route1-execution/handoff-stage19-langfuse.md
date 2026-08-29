# 交接说明:新窗口开展阶段 19(Langfuse 本地接入)

> 用法:把下面分割线之间的内容整段贴进新窗口。

---

用 learn-by-rebuild 的教学纪律(小步可运行、讲解落盘 lessons/、我说"下一步"才推进、说"提交"才 commit)带我在我自己的项目上完成一个阶段:给 starter-agent 接入本地 Langfuse,让攻击/拦截全程 trace 可见。

## 项目现状(动手前先读)

仓库 `/Users/divh/Downloads/安全评估agent`,一切发生在 `.scratch/agent-security-learning/` 下:

- 改造对象 `starter-agent/`:LangGraph ReAct + 3 个 MCP server(filesystem/shell/fetch),已挂三层护栏(agent.py:输入护栏在主循环、工具返回护栏在 `make_tool_guard`(wrap_tool_call + 分块扫描)、输出护栏在 `make_output_guard`(wrap_model_call + Sensitive));容器加固完成(Dockerfile 非 root + docker-run.sh 六项参数)
- 当前 banner 是"阶段 15",本阶段完成後改为"阶段 19"(16/17/18 是精读阶段,无代码改动)
- 启动方式:`scripts/run-with-keychain.sh`(LLM key 从 Keychain 注入,Minimaxi/MiniMax-M2)
- 攻击语料:`.scratch/agent-security-learning/issues/07-route1-execution/attacks/01-direct-injection.md`
- 教学记录:lessons 编号续到 0017,learning-records 续到 0020,都放 `issues/07-route1-execution/` 下
- 历史教训(别再踩):杀后台 job 要确认杀的是进程本体;agent 代跑服务必须后台 + disable_timeout;同文件连续 Edit 前必须重读

## 任务内容

1. **起 Langfuse 本地版**:官方 docker compose(参考 https://langfuse.com/self-hosting);先 `lsof -nP -i:3000` 查端口
2. **接入**:LangChain 官方集成(langfuse 包的 CallbackHandler 挂进 agent 的调用链),改动控制在 agent.py 几行 + requirements 加依赖(uv pip install --python .venv/bin/python,记得重新 freeze 锁文件);Langfuse 的 public/secret key 走环境变量,不硬编码;自托管实例的 key 在本地 UI 里建项目后获取
3. **验证(可观察变化)**:Langfuse UI(http://localhost:3000)里能看到——
   - 一条正常请求("workspace 里有哪些文件")的完整 trace:ReAct 每步、list_dir 工具调用输入输出、token 消耗
   - 一条被拦攻击(语料 01 的卡通 payload)的 trace:能看到输入护栏拦截这一事实(拦截不进 ReAct 图,怎么在 trace 里体现,是个要思考的点)
4. **想想再动手**:trace 里会出现工具返回内容(含假 .env)——Langfuse 的敏感数据掩码(masking)要不要开、怎么开,作为教学点处理

## 约束

- 防御逻辑零改动;Langfuse 只观测不干预
- 除 `deliverables/route1/` 外,产出文件归拢到 `issues/07-route1-execution/`
- docker compose 文件放哪、端口冲突怎么处理,开工时和我确认

## 教学要求

讲透:trace/span 的数据模型(和 OTel GenAI 语义约定的关系,路线 3 审计要用);callback handler 这种旁路观测接法为什么不改业务代码;自托管 vs SaaS 在安全项目里的取舍(观测数据本身敏感)。

---
