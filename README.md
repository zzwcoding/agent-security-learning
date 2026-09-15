# Agent 安全学习仓（agent-security-learning）

> 一个人的 AI Agent 安全工程学习仓：用一套完整的软件工程流程（SDD），从零造出「会干危险活儿的 LLM 系统」以及「管住它的安全体系」，全过程 400+ 提交、近百张工程票、每一个设计决策都有档案可查。

[![CI](https://github.com/zzwcoding/agent-security-learning/actions/workflows/ci.yml/badge.svg)](https://github.com/zzwcoding/agent-security-learning/actions/workflows/ci.yml) [![weknora CI](https://github.com/zzwcoding/agent-security-learning/actions/workflows/ci-weknora.yml/badge.svg)](https://github.com/zzwcoding/agent-security-learning/actions/workflows/ci-weknora.yml)

**概览 • 仓库地图 • soc-demo 速览 • 13 场景导览 • 快速开始 • 质量门禁 • 里程碑 • 方法论**

---

## 📌 这是仓什么

三条学习主线，共享同一套方法论：

1. **soc-demo（旗舰）**——一个"SOC 数字员工"：自动分诊安全告警、调查取证、沉淀知识，而**危险动作永远等人点头**。它是一个完整可运行的系统（9 容器、~1100 个测试、假 LLM 全栈可复现），更是一份"怎么给 LLM 系统上安全治理"的施工档案：8 道防线、11 条不变量、两票票务、审批/焚毁/审计全链路。
2. **复刻线群**——把业界安全件亲手复刻一遍再对比原版：NeMo-Guardrails、执行工具（Claude Code 式工具护栏）、攻防矩阵、日志脱敏（Presidio）、harness、codex-sandbox、自修改 agent。
3. **老战役档案（agent-security-learning/）**——soc-demo 之前的四条路线学习记录：红队回归、网关收敛、知识卡片 90 件。soc-demo 是它的收官之作。

方法不是"看文档学会"，是 **spec 驱动开发（SDD）+ 场景导览教学**：每个需求先逼问成无歧义清单，模块先画卡定边界（边界规则进 CI 闸），实现走 TDD，教学走"13 个场景一步步带你走代码"。

---

## 🗺️ 仓库地图

| 目录 | 是什么 | 状态 |
|---|---|---|
| **[soc-demo/](soc-demo/)** | SOC 数字员工：旗舰项目，需求→模块卡→spec→票→实现→压测→教学全档案 | ✅ v1 + 编排循环战役收官 |
| **[agent-security-learning/](agent-security-learning/)** | 老战役档案：四条路线学习记录 + 知识卡片 90 件 | ✅ 归档（详见下节） |
| **[weknora复刻/](weknora复刻/)** | [Tencent/WeKnora](https://github.com/Tencent/WeKnora) 学习复刻（RAG 内核第一幕） | 🚧 步 3→4 |
| 复刻线（NeMo-Guardrails学习/ 执行工具复刻/ 攻防矩阵复刻/ 日志脱敏复刻/ harness复刻/ codex-sandbox学习/ 自修改agent复刻/） | 各安全件复刻笔记与代码 | ✅ 归档 |
| 根目录调研文档 | Agent 安全调研总结 / LLM-Agent 学习路线规划 / 记忆开源项目调研 / 语言选型 / 沙箱机制选型 | ✅ 归档 |

---

## 🛡️ 老战役档案：四条路线

soc-demo 之前的完整学习战役（2026-08~09，档案在 [agent-security-learning/](agent-security-learning/)）。设计是**打怪升级**：每条路线先主动攻破自己的系统，再层层设防，上一关的"缺口清单"就是下一关的"开工清单"——四条路线走完，防线的思想才长成了 soc-demo。

### 路线 1 · 守门员（2026-08-27~29，攻击自证）

对象是最简形态的 agent：LangGraph ReAct + 手写 filesystem/shell/fetch 三个 MCP 工具（真 LLM 出站）。先**三类注入全中招**——直接注入、间接注入（工具返回内容带指令）、记忆投毒，拿到中招证据后再逐层设防：llm-guard 三层护栏（输入 deberta 注入分类器 / 工具返回分块扫描 / 输出 Sensitive 扫描）+ 容器六项加固 + Langfuse trace 掩码观测。产出三件：攻击复盘、防御回归、**7 条缺口清单**（egress→路线 2，记忆/执行闸/参数侧→路线 3，格式毒漏判→路线 4）。主文档：[01-攻击复盘.md](agent-security-learning/deliverables/route1/01-攻击复盘.md)

### 路线 2 · 堡垒（2026-08-29~09-01，执行隔离与凭证边界）

Agent 回宿主机直跑，但 shell/fetch 两个危险执行面搬进 **microsandbox microVM**（libkrun，Apple Silicon 原生，一次性虚拟机跑一条命令即焚）；出网设**两层防御**（工具层 egress 白名单 + 凭证策略 fail-closed）；自写 ~100 行**凭证代理**——LLM 和 fetch 的真密钥只活在代理里，agent 进程零密钥；Presidio 接记忆落库前脱敏；OTel 五要素审计（who/when/why/params/data_class）。验收是四次主动攻击（逃逸/egress/密钥不可见/审计复盘）全被按住。缺口 1 核销。

### 路线 3 · 城堡（2026-09-02，阶段 34-46，最大工程关）

从"防一层"进化到"收编成体系"：三个 MCP server 全量挂 **ContextForge 网关**唯一入口（EGRESS/FGA 双插件），Python 运维位 + TS 只读位**双消费者**（授权矩阵不退化）；**OpenFGA 四元组授权**（运维/只读双角色矩阵，六 check 全中）+ 120s 短时任务票；**串联闸**（D4 规则 + LLM 法官）+ 记忆装载三道闸 + 哈希链证据链；供应链体检毒样本 **1000/1000 抓获**。路线 1 的 7 条缺口至此销 5 条半。分工口径一句话：**网关管身份，agent 管会话，server 管出口**。主文档：[02-网关收敛与攻击复盘.md](agent-security-learning/deliverables/route3/02-网关收敛与攻击复盘.md)

### 路线 4 · 红队（武器化验证，部分挂起）

换武器库：**garak**（宽谱扫描）+ **PyRIT**（多轮编排攻击 + CI 回归集）系统性地打自己路线 1-3 建成的收官形态，Crescendo/PAIR 全量、TAP 对照；判分用**五条确定性 scorer**（LLM judge 只评分不进门槛，防自评注水）；招牌方法论是**剥层对照**——每次只关一层防线，判表记录"漏到第几层"，让每道防线的价值有数据。执行票开出后因路线 5 提前挂起，回归集种子十条已落 `starter-agent/redteam-regression/`，soc-demo 收官后待恢复。

### 路线 5 · 收官 demo = soc-demo

四条路线验证过的所有思想（三层护栏/microVM/凭证代理/网关收敛/FGA/串联闸/审计五要素/缺口清单文化）收编成一个正式工程化产品——**八道防线 × 三攻击面矩阵、六幕演示剧本、12 条待定项全决**的 PRD（[product-handbook](agent-security-learning/deliverables/route5/product-handbook.md)），并启用 SDD 三层窗口制实现——就是本仓旗舰 [soc-demo](soc-demo/)。平行衍生物：四条路线的学习过程沉淀为**知识卡片 90 件**（[知识卡片-碎片/](agent-security-learning/知识卡片-碎片/)）。

---

## 🏗️ soc-demo 速览

**一句话**：为被告警淹没的 SOC 提供一名"数字员工"——能力上对标真实 SOC 工作流（分诊→调查→富化→响应→沉淀），安全上把 8 道防线落到每个 agent 动作上：员工零权限、出站全凭 HMAC 手令、L2 动作必经人审批的一次性密令、知识入库必经人审、注入扫描 fail-closed、全链路五要素审计。

**编排循环（v2 主体）**：分析师提一个假设 → planner 从能力菜单选组合 → 扇出子 run 并行取证 → judge 裁决证据充分性 → gap 缺口驱动换组合再来一轮，直到收敛（命中建案 / 证伪归档）。第二业务（应急取证）以**零机制增量**落地——换业务只换一张数据模板，由 CI 里的零增量闸看守。

| 关键数字 | 值 |
|---|---|
| 容器 / 常驻循环 | 9 core + 3 可选 profile / 3 个轮询循环 |
| 语义不变量 / 防线 | INV-1~11 / D1~D8 |
| run 工种 / 能力菜单工具 | 7 种（含编排循环的 hunt_flow / hunt_task）/ 13+（四 SIEM 维度 + weknora 三工具） |
| 教学场景 / 大图 | 13 场景 66 步 / 13 张 per-scenario HTML 大图 |
| 测试 | ~1100 例（agent 717、web 143、evals 112…）+ evals 33/33 场景回归 |
| 压测（Apple M4 单机，fake LLM） | 分发循环 4.8 run/s；SSE 每订阅者 ~0.1% CPU；写面 1.4k/s 零错误；防线压下实验 fail-closed 全成立 |
| 紫队闭环 | 11 例攻击 fixture 自动转假设，自主发现率 **5/11**（ground truth 机器判定，同 seed 可复现），盲区报告指出四个缺失维度 |

### 组件清单（soc-demo，PRD §4.1 v1.2 冻结口径）

| # | 组件 | 技术栈 | 职责 | 部署形态 |
|---|---|---|---|---|
| C1 | 告警接入服务 | TypeScript / Node + Fastify | Wazuh 格式告警 webhook 接收、字段映射、`source+sourceRef` 去重、severity 映射、fixture 回放入口 | compose 服务 `ingest` |
| C2 | mock 案件后端 | TypeScript + SQLite（better-sqlite3） | TheHive 风格 Alert/Case/Task/Observable/Timeline/Audit 的 CRUD 与状态机；审计落库 | compose 服务 `case-backend`，SQLite 挂卷 |
| C3 | agent 编排服务 | TypeScript + LangChain.js / LangGraph.js | supervisor + worker 图编排、checkpointer、工具注册表、验票中间件、SSE 事件总线 | compose 服务 `agent` |
| C4 | llm-guard / Presidio 微服务 | Python + FastAPI（复用路线 1-3 管线） | 注入扫描（llm-guard）与 PII 识别/脱敏（Presidio） | compose 服务 `guards` |
| C5 | 已有 Python 后端（复用） | Python（ContextForge 网关 / OpenFGA / microsandbox / Langfuse） | RBAC 工具可见性、FGA 裁决、铸币（票签签）、trace 收集 | compose 服务 `gateway` |
| C6 | Chroma 向量库 | Chroma（独立容器） | 知识沉淀条目（KBEntry）的向量存储与检索 | compose 服务 `chroma` |
| C7 | Web 演示窗 | Vite + React + Ant Design 5 + SSE | 页面薄演示窗（§M10） | compose 服务 `web` |
| C8 | Eval 体系 | vitest + fixture 目录 + LLM judge | 回归评测（分诊准确率/防线拦截率/成本口径） | 非运行时，CI 与本地 `pnpm test:eval` |
| C9 | MCP 体检 CLI | TypeScript CLI | 对接入的 MCP server 做体检（工具描述投毒/权限范围/凭证暴露面） | 独立 npm bin，不进 compose |
| C10 | 告警 fixture 数据集 | JSON 文件 | 真实 Wazuh 告警落盘 + 注入变体 + 狩猎四维度语料 | 仓库内目录 `fixtures/` |

> 实现演进：C7 现为七页（+狩猎页）；C3 内 v2 长出编排循环 m14（hunt_flow/hunt_task）；openfga/chroma/contextforge 已是独立 compose 服务。原貌见 [PRD §4.1](soc-demo/docs/prd%201.2.md)，现状以 [specs/modules.md](soc-demo/specs/modules.md) 14 张卡为准。

工程档案：**近百张票**（`soc-demo/.scratch/tickets/`，每张带验收证据与实现记录）、PRD 两版、14 张模块卡、`docs/research/` 压测报告（四天花板理论 vs 实测）与 ADR。

---

## 🧭 13 场景导览（教学主线）

入门读场景文（为什么这么设计），回查用大图（代码落点索引）：

| # | 场景 | 一句话 | 大图 |
|---|---|---|---|
| S1 | 一条告警的一生 | 告警进门→去重→自动拉起→分诊→建案，主干道 | [图](soc-demo/lessons/scenario/1-big-picture.html) |
| S2 | 调查与富化 | 侦探查案的三条缰绳：隔离/扫描/预算 | [图](soc-demo/lessons/scenario/2-big-picture.html) |
| S3 | 知识沉淀 | 人审是知识入库唯一通道（INV-5） | [图](soc-demo/lessons/scenario/3-big-picture.html) |
| S4 | 高危动作审批 | 批准≠执行、一次性密令、用后即焚 | [图](soc-demo/lessons/scenario/4-big-picture.html) |
| S5 | 攻击者来了 | 注入/投毒/金丝雀，三个攻击面现场打 | [图](soc-demo/lessons/scenario/5-big-picture.html) |
| S6 | PII 脱敏与反查 | 打码是默认，看真身必留痕 | [图](soc-demo/lessons/scenario/6-big-picture.html) |
| S7 | 新增一个工具 | 登记先于代码，L0/L1/L2 三级 | [图](soc-demo/lessons/scenario/7-big-picture.html) |
| S8 | 系统自证 | evals/审计页/CI，系统证明自己没坏 | [图](soc-demo/lessons/scenario/8-big-picture.html) |
| S9 | 一个假设的一生 | 编排循环主干：假设→选组合→扇出→收敛 | [图](soc-demo/lessons/scenario/9-big-picture.html) |
| S10 | 动态编排的权限学 | 父票菜单面+子票单工具，越动态闸越紧 | [图](soc-demo/lessons/scenario/10-big-picture.html) |
| S11 | 第二个业务零增量 | 换业务只换数据模板，CI 闸看守 | [图](soc-demo/lessons/scenario/11-big-picture.html) |
| S12 | 紫队闭环 | 攻击自动转假设，自主发现率+盲区报告 | [图](soc-demo/lessons/scenario/12-big-picture.html) |
| S13 | 有记忆的狩猎 | 剧本库/图谱记忆省轮次，毒剧本进不了检索面 | [图](soc-demo/lessons/scenario/13-big-picture.html) |

全景地图与所有场景的索引：[lessons/scenario/0-0.md](soc-demo/lessons/scenario/0-0.md) • [00-导览总纲](soc-demo/lessons/scenario/00-导览总纲.md) • 术语表 [TERMS.md](soc-demo/lessons/scenario/TERMS.md)

---

## 🚀 快速开始（soc-demo）

```bash
cd soc-demo
cp .env.example .env          # 教学假值可跑（AGENT_LLM=fake 离线确定性，零出网）
docker compose up -d --build  # 九服务
bash scripts/setup-openfga.sh # 幂等重建 FGA 授权世界
pnpm replay                   # 告警 fixture 走 ingest webhook 正门
```

打开 http://localhost:5173 选脸登录（四预置身份，无密码）。可选 profile：Langfuse 观测（`--profile observability`）、Wazuh 真规则引擎（`--profile real-wazuh`）、椒图狗粮全外接（`--profile jiaotu`）。完整口径见 [soc-demo/README.md](soc-demo/README.md)。

压测复现：`node scripts/bench/b2-chain.mjs sustained`（链路持续流）、`b3-dispatcher.mjs`（分发水位）、`b5-guards-kill.mjs`（防线压下实验）。紫队闭环：`pnpm test:eval` 出自主发现率与盲区报告。

---

## 🔒 质量与安全门禁

CI 按 monorepo 子目录过滤触发（[ci.yml](.github/workflows/ci.yml) 管 soc-demo，[ci-weknora.yml](.github/workflows/ci-weknora.yml) 管 weknora复刻），门禁包括：

- **spec gate**：specs/ 格式与验收绑定机器校验（`tools/check_specs.py`）
- **边界闸**：14 张模块卡的边界规则 R1-R12 两向锁（`tools/check_boundary.py`，自测 22/22）
- **零增量闸**：内容层改动与机制层目录交集必须为空（`tools/check_zero_increment.py`，T20）
- lint + 类型检查 + 全部测试；不绿不合并

学习纪律：默认 fake LLM 零出网可复现；PII 一律假数据；密钥走环境注入不进仓库；压测数字只同机比。

---

## 📈 里程碑

| 阶段 | 内容 |
|---|---|
| 老战役（路线 1-5） | 三个红队/网关/沙箱路线 → 收官产物 soc-demo 立项 → 紫队回归资产 |
| soc-demo v1 | 全链实现（分诊/调查/知识/审批/对话/PII/Web/evals/MCP 体检）+ 椒图狗粮真网冒烟 + 8 场景教学 |
| 压测与防线验证 | 四天花板实测 + under-pressure 过载卸载 + 防线压下三实验（fail-closed 全成立） |
| 编排循环战役 | 假设驱动多 agent 动态编排（机制层/工具内容/紫队/Web）+ 架构验收件（第二业务零增量）+ 教学链 S9-S13 + 全局口径翻新 |

---

## 🤝 方法论

- **SDD 流程**：需求逼问（11 维清单逐维关闭）→ 模块卡+边界规则（进 CI）→ 功能 spec（验收逐条绑测试标识）→ 拆票（框架承诺落票）→ TDD 实现 → CI 守门 → 定期架构体检（四对账）。
- **场景导览教学**：每个场景七要素——业务比喻（术语表唯一真源）、代码落点（文件:行号实测）、为什么、亲手验证、捣乱实验、大图锚点、场景题。
- **偏差即资产**：发现的问题转发现票不就地修；压测的阴性结果（"没打崩"）与紫队的盲区报告（"发现不了什么"）同样是产出。

---

## 📄 声明

本仓为个人学习与研究用途。soc-demo 是教学演示系统：**不是生产可用的 SOC 产品**，量级口径为单机演示（详见压测报告的"明确不做"），安全机制用于学习"怎么设计"而非替代真实 SOC 的运营合规要求。引用的第三方项目版权归各自作者所有。
