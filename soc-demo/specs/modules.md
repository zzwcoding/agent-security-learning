# 模块划分图 · SOC 数字员工（v1，2026-09-04）

> 依据：PRD v1.1 §4-§6 + codebase-design 深模块纪律。每个模块一张接口卡。
> 铁律：跨模块调用只许走对方公开接口；接口卡变更必须回总窗口评审并记 ADR。
> 通过标准（阶段 2）：用户逐卡确认 + 依赖无环 + 无浅模块 + 架构图 v4 过审。

## 0. 全景与依赖方向

12 个 PRD 模块 → 7 个可部署单元（compose 服务）+ 2 个非运行时件：

```
                        ┌─────────────┐
  fixtures/alerts ─────►│ M1 告警接入  │  services/ingest
                        └──────┬──────┘
                               ▼ 写 Alert / 发事件
                        ┌─────────────┐        ┌──────────────────┐
                        │ M2 案件后端  │◄───────│ M10 Web 演示窗    │  services/web（薄，纯消费 API+SSE）
                        └──────┬──────┘        └──────────────────┘
                               ▼ alert.created（EventBus seam）
                        ┌─────────────┐
                        │ M3 编排     │  services/agent
                        │ (supervisor)│
                        └──────┬──────┘
              拉起子图+申领票据  │  ┌───────┴────────┬─────────────┬─────────────┐
                               ▼ ▼                ▼             ▼             ▼
                            ┌──────┐        ┌──────────┐  ┌──────────┐  ┌──────────┐
                            │ M4   │        │ M5 调查   │  │ M6 富化   │  │ M7 沉淀   │  （agent 服务内子模块，无独立 HTTP 面）
                            │ 分诊 │        │          │  │          │  │          │
                            └──┬───┘        └────┬─────┘  └────┬─────┘  └────┬─────┘
                               └─────────────────┴──────┬──────┴─────────────┘
                                                        ▼ 一切工具调用先过闸
                                            ┌───────────────────────┐
                                            │ M9 安全控制面          │  跨服务（TS 闸 + Python 件）
                                            │ S2 验票 → S1 凭证注入  │
                                            └───────┬───────────────┘
                        ┌─────────────┐             ▼
                        │ M8 对话     │    ┌──────────────┐  ┌─────────────┐
                        │ Copilot     │───►│ guards        │  │ gateway      │
                        └─────────────┘    │ llm-guard+PII │  │ 铸币/RBAC/FGA│
                                           │ (C4, py)      │  │ (C5, py+镜像)│
                                           └──────────────┘  └─────────────┘
   M6 analyzer 沙箱：microsandbox（一次性 microVM，PRD v1.1 变更 2/3）
   M7 检索面：chroma 容器
   M11 evals/（非运行时，CI+本地）  M12 packages/mcp-audit（独立 CLI）
```

依赖方向单向无环：`fixtures → M1 → M2 → M3 → M4/M5/M6/M7 →（工具调用）→ M9 → M2/外部`；M8 复用 M3 的 chat_flow；M10 只消费公开 REST+SSE；M11 是唯一允许"俯视全局"的件（评测驱动器）。

跨语言契约（防漂移）：任务票/审批票票面 = 固定 fixture 字符串 + 期望验票结果，py 签发侧与 TS 验票侧共用（`fixtures/tickets/`）。

## 1. 模块接口卡

### M1 告警接入 → services/ingest

- **职责**：Wazuh 告警进系统的唯一入口：webhook 接收、去重、映射、不可信标记、触发流水线
- **公开接口**：`POST /api/v1/webhooks/alerts`（契约见 PRD §6-M1）；`POST /internal/replay {fixture_dir, rate}`（fixture 回放，演示布景）
- **依赖**：M2（写 Alert）
- **Seam**：出站写库 = M2 REST（adapter：真实 HTTP / 内存 stub 供单测）
- **测试计划**：同一 fixture 连推 3 次只建 1 条；7 类具名 fixture 映射全过；注入变体带 `untrusted` 标记（eval 断言）
- **内部**：映射表、去重键约束均为确定性代码，无 LLM

### M2 案件后端 → services/case-backend

- **职责**：六实体 CRUD + 状态机 + 三结局 + 审计落库（全系统数据地基）
- **公开接口**：PRD §6-M2 的 REST 面（alerts/cases/timeline/audit/active 查询）+ **事件出口**：`alert.created` 等写后事件（EventBus seam）
- **依赖**：无（叶子模块）
- **Seam**：① 存储：better-sqlite3（真）/ 内存 SQLite（测）；② EventBus：SQLite outbox 表轮询（首版）/ 将来可换 Kafka（ADR 记录"为什么不上 Kafka"）
- **测试计划**：状态机迁移表全组合（非法转移 100% 409）；三结局具名 fixture；任意写操作必产审计 diff 条目
- **内部模块**：`statemachine`（迁移函数集中定义，非法转移抛 InvalidTransition）、`audit-signal`（写操作拦截器自动落审计）——内部 seam，不进公开接口

### M3 supervisor 编排 → services/agent

- **职责**：图编排与路由、checkpointer、票据申领、审批 interrupt、SSE 事件总线、资源兜底。**自己不持工具不做安全判断**
- **公开接口**：`POST /internal/runs {kind, alert_id}` → `202 {run_id}`；`GET /api/v1/events/stream?run_id=`（SSE，事件自增 id 落盘，`Last-Event-ID` 补发——已定决策 9）
- **依赖**：M2（读写案件）、M9-S2（验票）、gateway（铸票申领）、workers（子图）
- **Seam**：checkpointer 存储 = SQLite（信封 hash 链）；LLM 调用 = 经凭证代理（S1）
- **测试计划**：5712 fixture 全链路无人干预跑完；审批 interrupt 杀进程重启后状态可恢复且绑定原 (run, tool_call)；信封篡改 resume 必拒；超 token 预算 run 被强杀 + 审计
- **内部模块**：`graph`（图定义）、`events`（SSE 总线 + offset 重放）、`envelope`（信封 hash）、`budget`（资源兜底计数）

### M4 分诊 agent → services/agent 内子模块 `workers/triage`

- **职责**：单条告警 → 四分类 verdict + 处置建议。物理无 L2 票
- **公开接口**：无独立 HTTP 面；子图输入 `{alert_id, ticket}`，输出写回 M2（verdict_ai + 三结局动词）
- **依赖**：M2、guards（注入扫描）、KB 检索面（M7 的 approved 区）
- **Seam**：LLM 调用（adapter：minimax-m2 经凭证代理 / eval fixture 伪 LLM）；prompt 装配器 `wrapUntrusted`
- **测试计划**：标注集宏准确率 ≥80%；同主机 24h 两条 TP 只建 1 案；自我审计 checkpoint 100% 出现；并发同告警只分诊 1 次
- **注意**：prompt 契约（结构化输出 schema）是这个模块的事实接口，改动视同接口变更

### M5 调查 agent → services/agent 内子模块 `workers/investigation`

- **职责**：TP 案件关联调查 → 结构化调查报告进 Timeline。只提建议不动手
- **公开接口**：子图输入 `{case_id, ticket}`；工具签名契约（`siem_query` 强制 time_window 等，PRD §6-M5）
- **依赖**：M2、guards、KB 检索面
- **Seam**：SIEM 后端（adapter：fixture 告警集检索 / 将来真 Wazuh）；上下文治理（llm_summarize 小模型 / spill 落盘）
- **测试计划**：`invest/01_ssh_tp_full` 报告 schema 过 + findings 引用真实工具输出；超大结果落盘且上下文未超窗；防打转（同参数重复调用报错）

### M6 富化 agent → services/agent 内子模块 `workers/enrichment` + 沙箱运行时（v1.1 变更）

- **职责**：observables 跑 analyzer（Cortex 契约子集）+ TLP/PAP 闸门 + artifacts 回写
- **公开接口**：子图输入 `{case_id, ticket}`；analyzer 调用/返回契约照 PRD §6-M6
- **依赖**：M2、**microsandbox**（analyzer 在一次性 microVM 里真跑——至少一个 analyzer 为真实脚本）
- **Seam**：① analyzer 执行（adapter：microsandbox 真跑 / fixture 表 mock——默认 mock，演示攻击面切真跑）；② TLP/PAP 闸门在工具包装层（确定性中间件，不靠 prompt）
- **测试计划**：`enrich/01_vt_malicious_hash` taxonomy 正确；`enrich/02_tlp_red_blocked` 超限必拒 + DENIED 审计；**`attack/sandbox/01_poisoned_analyzer`：投毒 analyzer 尝试外联/读宿主 env 被沙箱拦截（第四攻击面）**

### M7 知识沉淀 → services/agent 内子模块 `workers/knowledge` + chroma

- **职责**：案件关闭 → 提炼 KBEntry 草稿 → 人审入库 → 检索注入提速下次分诊
- **公开接口**：PRD §6-M7 的 kb/proposals REST 面（挂在 M2 侧实现还是 agent 侧？→ **决策：REST 面挂 M2**（数据归属案件后端），agent 侧只出提炼子图）
- **依赖**：M2、chroma、guards（检索注入内容同样过不可信包装）
- **Seam**：向量库（adapter：chroma 容器 / 内存 stub 供单测）
- **测试计划**：`knowledge/01_fp_pattern_distill`；`knowledge/02_poison_rejected`（驳回后检索面确定性查不到）；replay 对结论一致且工具调用数下降

### M8 对话 Copilot → services/agent（chat_flow）+ gateway + guards

- **职责**：登录角色会话 → RBAC 可见工具 → 输入预检 → 意图闸 → 执行 → SSE 流式回答
- **公开接口**：`POST /api/v1/chat`（SSE，契约见 PRD §6-M8）；会话登录端点（4 预置身份）
- **依赖**：M3（复用 chat_flow）、gateway（RBAC 可见性 + FGA 裁决 + 铸票）、guards、M2
- **Seam**：FGA 裁决（adapter：openfga 容器 / 静态规则表 stub 供单测）
- **测试计划**：`chat/01_ip_pivot`；`chat/02_injection_input` 拒答+审计；soc1 发起 L2 意图 100% deny；可见工具清单按角色快照 diff

### M9 安全控制面 → 跨服务（TS 闸在 agent，Python 件在 gateway/guards）

- **职责**：LLM 是不可信决策者的全部强制落地：凭证代理 / 验票闸 / 注入防线 / PII / 审计 / 子 agent 权限收窄
- **公开接口**：
  - `verifyTicket(toolCall, ctx) → allow|403+reason`（TS 中间件签名，PRD §6-M9-S2）
  - 审批卡 REST：`GET /api/v1/approvals?status=pending`、`POST .../approve|reject`（挂 agent 服务，铸票调 gateway）
  - gateway：`POST /internal/mint`（签任务票/ApprovalToken，py 侧，task_token.py 票型）
  - gateway：`/proxy/llm/*`（凭证代理转发，proxy.py 参数化，LLM base_url 指这里）
  - guards：`POST /scan/injection`、`POST /pii/anonymize`
- **依赖**：openfga 镜像（FGA）、M2（审计落库、used_tokens 焚毁表——**决策：焚毁表放 M2**，审计同库同事务）
- **Seam**：铸币（adapter：HMAC 自签教学版 / 蓝图 STS）；验票与签发跨语言共享 `fixtures/tickets/` 契约
- **测试计划**：`attack/privesc/01_triage_calls_isolate` 403+DENIED；伪造审批文本 403；token 重放第二次 403；金丝雀凭证全链路 grep 不到；验票闸延迟 ≤5ms；worker × 非 scope 工具遍历 100% 403
- **注意**：这是差异化主体，六张卡（S1-S6）共用这一张模块卡，但每个 S 的验收标准独立可测

### M10 Web 演示窗 → services/web

- **职责**：六页面薄客户端，全部数据走公开 REST+SSE，无特权接口
- **公开接口**：六个路由（告警列表/流水线视图/审批卡/案件时间线/审计流/Eval 结果），之外无任何路由
- **依赖**：M2/M3/M8/M9 的公开 API
- **Seam**：数据源（adapter：真后端 / MSW 或 fixture 打桩供前端单测）
- **测试计划**：六幕剧本 Web 全通 + 每幕 curl 等价脚本；路由快照防范围蔓延

### M11 Eval 体系 → evals/（非运行时）

- **职责**：三维评估（分诊准确率/防线拦截率/成本口径）+ CI 快慢两道
- **公开接口**：`pnpm test:eval [-- --tags regression]`；产出 `eval-results/latest.json + cost_all.csv`
- **依赖**：全部模块（唯一允许俯视全局的件）
- **Seam**：被测栈（adapter：单测级注入=PR 门禁快道 / 全栈 compose=每日慢道——已定决策 10）；judge（`JUDGE_MODEL`，只评分不进门槛）
- **测试计划**：用例 ≥30（分诊 ≥10 / 攻击 ≥10(四面) / 审批 ≥3 / replay ≥2 / 对话 ≥3）

### M12 MCP 体检 CLI → packages/mcp-audit（独立 npm bin）

- **职责**：MCP server 静态体检：投毒描述/权限面/凭证暴露/rug-pull 提示
- **公开接口**：`soc-mcp-audit <cmd-or-url>` → `mcp-audit-report.{md,json}`
- **依赖**：guards（注入扫描，可降级为本地规则——已定决策 11 CLI 内嵌）
- **Seam**：MCP transport（stdio/sse 各一 adapter）
- **测试计划**：≥3 公开 server + 1 内置恶意 fixture server 投毒 100% 检出

## 2. 新增 compose 服务（相对阶段 0.2 骨架）

- `openfga`（官方镜像，M9-S6/M8 FGA 裁决）——setup 脚本按 ADR 0001 思路幂等重建授权模型
- `contextforge`（官方镜像，替代 gateway 占位 FastAPI 的 RBAC/渠道面；自写插件挂载）
- gateway 服务形态 = **三个容器并排**（2026-09-04 用户拍板）：`contextforge` 镜像（RBAC/渠道面）+ `openfga` 镜像（FGA 裁决）+ 自写小 FastAPI（铸币 `POST /internal/mint` + 凭证代理 `/proxy/llm/*`，proxy.py 近乎原样可用）。自写件不动镜像内部，排障简单
- `microsandbox`：不是常驻服务，按需拉起一次性 microVM（M6 调用时创建）
- Langfuse：**不进默认 compose**（v1.1 变更 1），可选 profile `observability`

## 3. 明确砍掉/不做的

- Redis/Kafka：不引入；EventBus seam 用 SQLite outbox adapter 首版（将来换实现不换接口）
- M2 多租户/认证、M10 配置管理、M7 自动入库：照 PRD §11 边界声明
