# 36-01 · case_flow 上线：调查+富化链接进生产

> 票 36（B4+G2-5+G2-6）的教学文档。读前提问：跑通项目、看懂分诊（见 run-01-分诊.md）。

## 一、三问（这一阶段是干嘛的）

**位置感先行**——终极目标是 PRD 的六幕消息旅程，一张图标出你在哪：

```
告警接入(09) → 分诊(13/27) → 建案 → 调查(14) → 富化(15) → 沉淀(17) → 对话(18)
   ✅ 上线       ✅ 上线      ✅     ⬜ 零件造好了       ⬜       ✅ 上线    ✅ 上线
                                 （只有测试能直达，生产够不着）
                                  ↑ 本票（36）就是修这段路 ↑
```

- **这一阶段是干嘛的？** 调查 worker（m5）和富化 worker（m6）在票 14/15 就写完了、测试全绿——但它们像装好的发动机没接油门：生产上告警跑完分诊就"到站下车"，TP 建了案没人去查。本票把「建案 → 调查 → 富化」接成生产线，并且开两个入口：① 告警流程（alert_flow）TP 建案后**同一个 run 内**自动接上；② 拿案件 id 直接拉一条 case_flow（调试/重跑用）。
- **什么需求逼我们这么设计？** PRD §4.2 消息旅程步骤 7-8 白纸黑字：建案之后调查出报告、富化跑分析器。体检（2026-09-09）把这记成硬欠账 B4——"生产面无入口，仅 evals 直构"。
- **解决了什么麻烦？** "零件都合格、整车开不动"的麻烦。顺路清了两笔旧账：调查工具面声明的 add_task_log 执行期只会报错（G2-5，两头不一致）；调查循环的工具输出没过注入扫描（G2-6）。

## 二、全链路一览

```
POST /internal/runs {kind:"alert_flow", alert_id}
        │
        ▼
  ③ 铸任务票（agent→gateway）…………………发钥匙：allowed_tools=分诊∪调查∪富化三族并集
        ▼
┌─ 分诊六节点 ────────────────────────────┐
│ load_alert→kb_check→merge_check→       │  …看告警、查知识库、查同主机旧案
│ self_audit→verdict_llm→outcome ────────┘
│                                │
│                     TP 且无活跃同主机案？
│                                │是
│                    outcome 节点 create_case ──→ 把新案件 id 写进交接态 state.case_id
└────────────────────────────────┼─────────
                                 ▼
              investigate_case（调查，链上交接节点①）
                 │ 读 state.case_id（没有就空转跳过——FP 走这条）
                 ▼
                 调查子图：load_case→plan→tool_loop→report_llm→write_timeline
                 │        tool_loop 里 siem_query 等工具输出先过 guards（flag 打标）
                 ▼
              enrich_case（富化，链上交接节点②）
                 │
                 ▼
                 富化子图：案件 observables 逐个过 analyzer（vt_lookup 查情报表）
                 │        TLP/PAP 闸门拦超密级的
                 ▼
        两份报告落案件时间线（investigation_report / enrichment_report）
                                 │
                                 ▼
                 web 流水线视图：case_flow 预置骨架两节点亮起（票 36 起收编）
```

直拉入口（`{kind:"case_flow", case_id}`）跳过分诊段，从 investigate_case 直接开跑。

## 三、跟着数据走（vt-87105 恶意文件告警，一步步看）

1. **进**：`seedAlert` 把 `fixtures/alerts/vt-87105-malware.json` 推进 M2，`POST /internal/runs {kind:"alert_flow", alert_id}` → 202 + run_id。
2. **发钥匙**：拉起时铸一张任务票，`allowed_tools` = 分诊六件套 + 调查六件套 + 富化四件（去重并集）。为什么现在就得发全？票在跑之前铸，而"要不要调查"要跑到 verdict 才知道——并集是**当下能证明的最小超集**（里面没有任何 L2 工具，INV-3 不破）。
3. **判**：FakeTriageLlm 决策阶梯 R2 命中（malicious file）→ tp；merge_check 没找到同主机活跃案 → `create_case`。关键一行在 `workers/triage/flow.ts:329`：`ctx.state.case_id = created.caseId`——新案件 id 从这里才出生，写进交接态。
4. **交接**：链上节点 `investigate_case` 开跑，第一件事读 `ctx.state.case_id`。它是从交接态**运行时**解析的，不是组图时写死的——因为组图那一刻案件还不存在。没有 case_id（FP/BTP/并入旧案）→ 直接 return，链空转。
5. **查**：调查子图 `load_case` 拉案件视图 → `plan` 列任务清单 → `tool_loop` 里 LLM 决定调 `siem_query` 查主机痕迹。每次工具输出（SIEM 是可被污染的第三方数据！）先过 guards 的 tool_output 通道——策略是 flag 打标不拦：证据一个字节不丢，但观察元数据和审计里都留下 `tool_output_flagged` 等人复核。
6. **写**：`report_llm` 出结构化报告（findings 必须引用真调过的工具，防编造），`write_timeline` 过闸写进时间线，kind=`investigation_report`，author=`agent:investigation`。
7. **富化**：`enrich_case` 接力——案件的 observables（那个恶意文件 hash）逐个 `vt_lookup` 查 `fixtures/ti/` 情报表 → 命中 malicious → 报告落时间线 kind=`enrichment_report`。
8. **捣乱实验（FP 告警 web-31103）**：verdict=fp → 不建案 → `state.case_id` 始终不存在 → 节点轨迹里 investigate_case/enrich_case 照样出现（supervisor 的路由决策点可见）但秒过，工具调用里没有 siem_query/vt_lookup，时间线没有两份报告，run 照常 completed。闸门没开，钥匙白带。

## 四、新技术点四要素

### 4.1 组链器：交接态运行时解析 + 子状态隔离

- **名字**：本项目自创模式（`workers/case-flow.ts` 的 makeCaseFlow），底层机制是 LangGraph 的 FlowNode 交接态（NodeCtx.state）。
- **作用**：把两个独立子图串进一张 runner 图，且**串的时刻还不知道关键参数**（case_id）。生活化比喻：旅行社把两程机票订在同一个信封里，但座位号要在check-in 时才填——信封上贴张字条（state.case_id），后一程自己看字条。另一 个坑：两个子图内部都有叫 `load_case` 的节点，放进同一张 StateGraph 会撞名——所以链在 runner 图里只有两个"交接节点"，子图在节点**运行期**才构造，且给它一份干净的小状态（子状态隔离），产物用命名空间键（`state.investigation`/`state.enrichment`）并回主状态，不跟分诊前段的键互踩。
- **参数**：`makeCaseFlow(deps)` 的 deps 是 `{invest, enrich}` 两包，类型上用 `Omit<InvestigationDeps, "caseId">` **禁止**传 caseId——编译器层面逼你走运行时解析，不留"组图时猜一个"的口子。
- **用法**：

```ts
// workers/case-flow.ts:51（节选）
export function makeCaseFlow(deps: CaseFlowDeps): FlowNode[] {
  return [{
    name: "investigate_case",
    run: async (ctx) => {
      const caseId = caseIdOf(ctx);          // 运行时从交接态读
      if (!caseId) return;                   // 没建案 → 空转跳过
      const sub: NodeCtx = { ...ctx, state: { case_id: caseId } };  // 干净子状态
      for (const n of makeInvestigationFlow({ ...deps.invest, caseId })) await n.run(sub);
      ctx.state.investigation = { outcome: sub.state.outcome };      // 命名空间并回
    },
  }, /* enrich_case 同构 */];
}
```

### 4.2 任务票工具族并集（fail-closed 下的最小超集）

- **名字**：TICKET_SPECS 按 kind 铸票（`services/agent/src/app.ts`），FR-M3.4"拉起即申领任务票"。
- **作用**：票是工具执行的唯一通行证（闸只认票不认 LLM 嘴）。链上运行需要调查/富化工具，但铸票在跑前、verdict 在中途——解法是把票面 allowed_tools 发成三工具族并集。**并集 ≠ 放水**：并集里没有任何 L2（INV-3 复核有测试咬住），闸依旧逐次验票；FP 告警带着调查工具授权但永远没节点去用——"发了钥匙"和"开了门"是两回事。
- **参数/用法**：

```ts
// services/agent/src/app.ts（节选）
alert_flow: {
  sub: "agent:triage",
  scope: ["alert:update", "case:write"],
  allowedTools: [...new Set([...TRIAGE_TOOLS, ...INVESTIGATION_TOOLS, ...ENRICHMENT_TOOLS])],
},
```

（备选的"链段单独铸第二张票"要动 makeNodes 票务 seam，等真需要再动——出入记在票面。）

## 五、关键顿悟

- **子图不是节点**：链在 runner 图里只有两个交接节点，子图内部节点（load_case/plan/tool_loop…）不进 runner 图——一是同名会撞，二是组图时案件还不存在没法预组。内部过程并不黑：tool_call/tool_result/audit 帧带内部节点名，SSE 和审计全程可回放。
- **铸票时刻 vs 知道时刻**：票面授权必须在"信息最少的时候"发，所以发超集；安全性不靠发得少，靠**每次执行前闸还在**。这是 fail-closed 设计的一课：闸是最后防线，票面只是预先授权范围。
- **审计要查对门**：建案的 create 审计落在 M2 的 audit_entries，不在 agent 自己的 audit sink——INV-8 是"两路汇入"（票 35），各有各的账本。测试里查错门会得到假红。

## 六、亲手验证

前提：compose 已起、已 replay（见 run-01-分诊.md 第 2 节）。

```bash
cd soc-demo
# ① 拿一个已建案的 case id（或先用页面/SQLi 告警跑一次分诊建案）
curl -s http://localhost:3002/api/v1/cases

# ② 直拉一条 case_flow（调查+富化链）
curl -s -X POST http://localhost:3003/internal/runs \
  -H 'content-type: application/json' \
  -d '{"kind":"case_flow","case_id":"<上一步的 caseId>"}'
# 应看到：{"run_id":"run_…"}

# ③ 时间线里应同时有两份报告（各至少一条）
curl -s http://localhost:3002/api/v1/cases/<caseId>/timeline \
  | grep -o 'investigation_report\|enrichment_report' | sort | uniq -c

# ④ web 流水线视图：打开 http://localhost:5173 进该案详情，
#    应看到 investigate_case / enrich_case 两个预置节点（其余 kind 仍动态发现）
```

捣乱实验：对 FP 告警（web-31103）拉 alert_flow，应看到 run completed、无新案件、时间线无两份报告——链上节点空转跳过。

单测复现：`pnpm --filter agent test -- case-flow`（6 条：直拉 2 + 链上 2 + 契约 2）。
