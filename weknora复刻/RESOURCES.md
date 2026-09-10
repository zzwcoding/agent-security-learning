# RESOURCES · 信源清单

讲解论断必须挂信源；写 lessons 引用源码行号前先重新核对（凭记忆写证据地图会漂移）。

## WeKnora 源码（调研/对照基准）

- 克隆：`git clone --depth 1 https://github.com/Tencent/WeKnora /tmp/weknora-research`
- 调研基线 commit：`1c16db3`（2026-09-10 main）
- 关键源码地图：见 `HANDOFF.md §5.1`（入库链 / 四管线开关 / 图谱 / Wiki / 检索引擎层，均附实测路径行号）

## 理论底座

- 李博杰《深入理解 AI Agent》第三章《用户记忆和知识库》：
  `curl -s 'https://raw.githubusercontent.com/bojieli/ai-agent-book/main/book/chapter3.md' -o /tmp/chapter3.md`
- 章节知识地图：见 `HANDOFF.md §5.2`（3.2 RAG 基础 / 3.3 超越扁平文本 / 3.4 智能体化 RAG / 3.5 上下文感知检索）

## 已有调研文档（仓库根，直接读）

- `/Users/divh/Downloads/安全评估agent/WeKnora调研.md`（十章 ~3 万字，逐文件源码级）
- `/Users/divh/Downloads/安全评估agent/agentjiaotu/docs/research/2026-09-10-WeKnora安全工程对照.md`

## 环境

- API key（macOS Keychain，不硬编码不自动 fetch）：`agent-key <供应商>`
- Python 环境：`uv venv .venv` → `uv pip install --python .venv/bin/python -r requirements.txt`

## 已知翻车点

- uvicorn reload 传字符串 `"app:app"`
- 后台任务默认 600s 超时杀服务（agent 代跑服务必须 `disable_timeout`）
- 惰性生成器 + 同连接查询死锁（先取完再循环）
- SQLite 单写者水位线
