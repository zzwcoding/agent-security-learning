# HANDOFF：路线 2 堡垒执行交接文档

> 新窗口开工前读本文件。它把路线 2 执行所需的全部上下文钉在一起：项目现状、已定决策、四阶段任务单、技术规格、验收标准、工作约定。
> 生成时间：2026-08-29（路线 1 收官当日）。对应票：`.scratch/agent-security-learning/issues/09-route2-execution.md`。

---

## 0. 一分钟定位

- **项目根**：`/Users/divh/Downloads/安全评估agent`（git 仓库，远程 `github.com/zzwcoding/agent-security-learning`，私有）
- **工作目录**：`.scratch/agent-security-learning/`（地图、票、交付物、Agent 全在这里面）
- **你在哪**：wayfinder 地图驱动的学习项目，路线 1「守门员」已收官（票 07 关闭），现在要执行**路线 2「堡垒」**：心智升级——"注入防不住是必然，攻进来之后什么也得不到"
- **本任务目标**：把 Agent 改造成"就算被完全劫持也无法造成实质伤害"的形态

## 1. 必读上下文（按序读）

| 文件 | 读它为什么 |
|---|---|
| `map.md` | 全局地图：目的地、Notes、已决索引 |
| `issues/09-route2-execution.md` | 本任务的票（任务单原文） |
| `issues/08-route2-plan.md` 的 Answer | **路线 2 全部已定决策**，本任务的施工图 |
| `issues/04-microvm-on-mac.md` 的 Answer | microsandbox 选型研究结论（安装、SDK 形态、beta 风险） |
| `deliverables/route1/03-已知缺口清单.md` | 7 条缺口，**缺口 1（egress）归本关核销** |
| `LLM-Agent安全学习路线规划.md` 第五节 | 图纸路线 2 原文（项目根目录） |
| `deliverables/route1/01-攻击复盘.md` | 路线 1 攻防全貌，本关攻击复用它 |

## 2. 起步 Agent 现状（路线 1 收官形态）

代码在 `.scratch/agent-security-learning/starter-agent/`：

- `agent.py`：LangGraph ReAct + CLI + 会话记忆；**三层 llm-guard 护栏已集成**（PromptInjection 扫输入、分块扫工具返回、Sensitive 扫输出）；Langfuse CallbackHandler 已接入（含 `mask_secrets` 出库前掩码）
- `mcp_servers/`：filesystem（带路径守卫）/ shell（`shell=True` 裸奔）/ fetch（GET+POST 裸奔），同一 FastMCP 模式，stdio 子进程
- `config.py`：MiniMax-M2（OpenAI 兼容端点）；真 key 走 `scripts/run-with-keychain.sh` 从 macOS Keychain 注入环境变量；`.env` 全是假密钥
- `memory.json`：持久化记忆（路线 1 已演示投毒，毒效被输出层兜住但毒源未清——缺口 2/7 归路线 3，**本关不动**）
- `Dockerfile`：六项加固（非 root/只读 fs/tmpfs/限额/降 cap/锁依赖），egress 未限是既定缺口
- 运行形态：**当前在加固容器内**；路线 2 要改为**宿主机直跑**（见 §3 决策 1），容器保留作对照基线

## 3. 已定决策（票 08 Answer 摘要，勿重新争论，有异议回主窗口开新票）

1. **microsandbox 接入形态**：Agent 回 macOS 宿主机直跑（microsandbox SDK 依赖 Hypervisor.framework，容器内不可用）；**shell + fetch 两个工具的执行面都进 microVM**；fetch 配 egress 白名单核销缺口 1；加固 Docker 降为对照基线
2. **凭证代理**：自写 ~100 行本地 HTTP 代理，全管两路——LLM 流量（Agent base_url 指向代理，代理注入 MiniMax key 转发）+ fetch 出站按域名占位符替换；microsandbox 内建 per-domain secret 注入**只对照阅读**，不替代手写
3. **Presidio**（1 天上限）：接 `memory.json` 落库前（Analyzer→Anonymizer）；encrypt 可逆模式只画数据流图不实现
4. **实验复刻**（各约半天）：chapter9/self-modifying-agent 随阶段 1 对照复刻；chapter5/async-agent 作"进程级 vs microVM 级"对照讨论（不落地白名单）；chapter3/log-sanitization 与 Presidio 配对（顺手起 Ollama）；Firecracker design doc + gVisor 架构指南精读（半天至一天）
5. **验收**：四次主动攻击（逃逸 / egress / 密钥不可见 / 审计复盘），交付物三件

## 4. 四阶段任务单

### 阶段 1：microVM 接入（约 1 天）

- `brew install superradcompany/tap/microsandbox`，`msb run python` 跑通
- Agent 回宿主机直跑：用 `starter-agent/.venv`（已存在），Keychain 注入脚本在宿主机直接可用
- 改造 `shell_server`：命令不再本地 `subprocess`，改为经 microsandbox Python SDK `Sandbox.create()` 拉一次性 microVM 执行
- 改造 `fetch_server`：HTTP 请求在 microVM 内发出，SDK 配 `allowed_hosts` 白名单——**这就是缺口 1 的核销点**，白名单初值只放 `httpbin.org`（验收用）和真实需要的域名
- 加固 Docker 镜像跑同一段逃逸代码（读宿主路径/扫内网/提权），与 microVM 结果对比留证据
- 复刻 chapter9/self-modifying-agent（平行窗口，产物放 `issues/09-route2-execution/self-modifying-agent复刻/`）
- ⚠️ microsandbox 是 beta：先花 30 分钟跑通 SDK 最小闭环再改造，踩坑记 record

### 阶段 2：凭证代理（约 1 天）★本关核心

- 自写 ~100 行本地 HTTP 代理（FastAPI/Flask 均可），规格：
  - **LLM 路**：监听 `127.0.0.1`，Agent 的 OpenAI client `base_url` 指向代理；代理从 Keychain 取真 key 注入 `Authorization` 转发 MiniMax 端点；Agent 进程环境里只有 `PLACEHOLDER`
  - **fetch 路**：fetch 工具请求中的 `{{SECRET:name}}` 占位符由代理按**目标域名**匹配替换（域名不在策略表 → fail closed 拒绝）；策略表 = "哪些域名能去、去时带什么凭证"，和 egress 白名单放同一处（路线 3 网关思想预演）
  - 代理本身不记 body 明文日志（或落库前过 `mask_secrets`）
- Keychain 注入脚本改造：真 key 只进代理进程，不再进 Agent 进程
- 对照阅读：microsandbox 文档的 per-domain secret 注入一节，写三行对照笔记即可

### 阶段 3：脱敏 + 审计（约 1 天）

- Presidio：`memory.json` 落库前过 Analyzer→Anonymizer；pipeline 数据流图手画一份（这是 JD 第 3 条"数据脱敏"的落点）
- encrypt 可逆模式：只画"脱敏上云、响应还原"数据流图，留路线 4 熟悉档，不实现
- OTel GenAI 语义约定：审计字段定为"谁 / 何时 / 以何理由（本轮用户消息引用）/ 调了什么工具带什么参数 / 碰了什么数据（分级）"，落到现有 Langfuse trace 的 metadata
- 复刻 chapter3/log-sanitization（平行窗口；顺手 `ollama` 起本地模型，为路线 4 端云档热身）

### 阶段 4：边界验证 + 复盘（约 1 天）

- 四次主动攻击验收（见 §5）
- 复刻 chapter5/async-agent（半天，对照讨论"microVM 里还要不要白名单"，结论写进复盘）
- Firecracker design doc + gVisor 架构指南精读（产出对照笔记：共享内核 vs 用户态内核 vs 独立内核）

## 5. 验收标准（`deliverables/route2/` 三件）

1. **边界对比报告**：加固 Docker vs microVM，同一段逃逸代码的边界差异（附实测证据）
2. **劫持无效化验证记录**：四次主动攻击全过程——
   - 逃逸：注入得手后 shell 只见一次性 microVM 内部
   - egress：fetch 向白名单外域名外泄密钥被拒（缺口 1 核销证据）
   - 密钥不可见：Agent 进程内 dump 环境/可见面找不到真 key
   - 审计：四次攻击在 Langfuse 按 OTel 字段可完整复盘
3. **缺口 1 核销记录**：白名单拦截实测 + 对 `03-已知缺口清单.md` 的销项说明

## 6. 工作约定（沿用路线 1 全套规矩）

- 开工先建 `issues/09-route2-execution/MISSION.md`（格式照抄 `issues/07-route1-execution/MISSION.md`：一句话目标/为什么学/验收标准/约束/阶段路线表）
- **编号续排**：lessons 从 **0018** 起（路线 1 用到 0017）；learning-records 从 **0022** 起（路线 1 用到 0021）；知识卡片续 `知识卡片-碎片/` 现有编号
- 文件归拢：除 `deliverables/route2/` 外，本任务产出全部放 `issues/09-route2-execution/`
- 提交纪律：每阶段一笔 commit，消息前缀 `阶段 N:`；里程碑 push 到 GitHub
- 战利品不变：假密钥 `INTERNAL_API_KEY` + `run_command` 非预期命令
- 真 key 只走 Keychain；`.env` 永远只有假密钥
- 改造对象唯一：`starter-agent/`，不另起 demo

## 7. 新窗口开场白（复制即用）

```
读 /Users/divh/Downloads/安全评估agent/.scratch/agent-security-learning/issues/09-route2-execution/HANDOFF.md，
按它执行路线 2。先建 MISSION.md，然后从阶段 1 开始。
```

## 8. 收官后回主窗口

路线 2 完成后回主窗口（带地图的会话）交差：票 09 写 Answer 关闭 → 按滚动式排期开**路线 3 方案票**（输入已备好：缺口 2/3/7 备料方案、ContextForge 研究结论票 05、证据链四件套）。
