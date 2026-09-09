# 42-01 · invest 维入 evals：具名布景转正与缝上记录仪

> 票 42（G2-8 清偿）的教学文档。读前提问：看懂票 14 的调查 worker 三条缰绳、知道 evals 是干嘛的（m11：给 agent 考试的体系）。

## 一、三问（这一阶段是干嘛的）

**位置感先行**——终极目标是 PRD 六幕消息旅程 + 三维评估体系，一张图标出你在哪：

```
告警接入 → 分诊 → 建案 → 调查 → 富化 → evals 考试体系
  ✅        ✅      ✅     ✅(36上线)  ✅      ⬜ 六个域缺一个
                                              ↑ 票 42 补的就是这块 ↑
```

- **这一阶段是干嘛的？** evals 里已经有分诊/攻击/审批/replay/对话五个考试域，唯独"调查"没有考卷——但调查 worker 票 14 就考过试了（它自己的单测）。本票把票 14 当时的考卷**转正**：变成一条具名 eval 用例 `investigation/01_ssh_tp_full`，从此 `pnpm test:eval` 跑完，报告里调查维有自己的一行。
- **什么需求逼我们这么设计？** 体检（2026-09-09）记了一笔账 G2-8："invest 具名 eval fixture 未落 evals（票 22 无 investigation 域）"。源头是票 14 的一条**出入记录**：票 14 的验收写着"invest/01_ssh_tp_full：报告 schema 过 + findings 引用真实工具输出"，但当时 evals/ 还不存在（evals 是 m11 票 19/22 才建的），票 14 只能"借用"自己的单测复现同一布景，并留言"m11 落 evals 时把布景搬进 harness"。票 42 就是来还这句话的。
- **解决了什么麻烦？** 两个。一是**考试覆盖不全**：调查链在票 36 接进生产后，eval 却没有一条从生产入口考它的用例——出报告的活干了，考试体系看不见。二是**断言散落**：调查的验收断言（schema 过/findings 溯源/缰绳不触发/只提建议）只活在 worker 单测里，eval 的确定性门槛（FR-M11.3）吃不到它们。

## 二、全链路一览

```
test_case.yaml（fixtures/eval/investigation/01_ssh_tp_full/）
   │  input.scenario: invest_ssh_tp_full ←── 用例是数据：loader 扫目录自动发现
   ▼
runner.runCase ──发现 scenario 字段──▶ runScenario 分发表
   │
   ▼
scenarioInvestigationFull（evals/src/scenarios.ts，票 42 新增）
   │
   │ ① 布景：5712 真实暴力破解告警 → create-case（票 14 同款）
   │ ② 装记录仪：SIEM/M2/KB 三个 seam 包一层，工具原始输出全部留底
   │ ③ 拉起：buildApp + POST /internal/runs {kind:"case_flow", case_id}
   │        └─ 生产入口，票 36 的组链器：investigate_case → enrich_case
   ▼
取证：事件流 / 两路审计 / timeline / run 行
   │
   ▼
六个调查维专项检查（extraChecks，进门槛）
   ├─ invest_report_in_timeline      时间线有 investigation_report 条目
   ├─ invest_report_schema_pass      parseReport 逐字段把关 + findings ≥1
   ├─ invest_findings_evidence_real  source_tool 真调过 + evidence 逐字在工具输出里
   ├─ invest_reins_not_triggered     三条缰绳零触发
   ├─ invest_recommend_only          建议 isolate_host 只进报告，零 L2 调用
   └─ invest_case_flow_chain         节点轨迹 = 调查在前富化在后（生产链序）
```

## 三、跟着数据走（一条用例从 yaml 到 latest.json）

1. **发现**：loader 扫 `fixtures/eval/*/*/test_case.yaml`，看到新目录 `investigation/01_ssh_tp_full`——新增一个域**不用改任何分发代码**，目录即用例（ HolmesGPT fixture 目录制的好处）。`input.scenario: invest_ssh_tp_full` 决定它走具名布景执行器。
2. **布景**：`seedAlert` 把 `ssh-5712-real.json`（18.18.18.18 对 blimey 账号暴力破解）推进真 case-backend → `create-case` 建案。FakeInvestigationLlm 看到案件实体：ip=18.18.18.18、user=blimey、host=centos7。
3. **拉起**：`POST /internal/runs {kind:"case_flow", case_id}`。票由 `/internal/runs` 的 TICKET_SPECS 铸（case_flow 票面 = 调查∪富化工具并集，无任何 L2）——布景走的是生产入口，不是绕过生产的直构调用（票 36 清偿 B4 的教训：生产行为必须从生产入口够到）。
4. **调查循环**：`get_alert` 锚定时间窗 → `siem_query` 按 IP pivot（命中 5712 爆破日志 "Invalid user blimey…"）→ `related_alerts` 聚合同主机 → `kb_verify` 核验资产（MemoryKb 里 centos7 在册）→ `finish` 收口出报告 → `add_timeline_entry` 写入。共 7 次工具调用（< max_tool_calls 15，< max_steps 20）。
5. **富化接力**：enrich_case 对案件 observables 跑 analyzer，18.18.18.18 不在 `fixtures/ti/` 情报表 → no-record 如实记录（不报错不编造）。
6. **取证判分**：runner 把通用确定性断言（run_completed/forbidden_tools/max_tool_calls/审计五要素…）和布景的 6 个专项检查汇合，全部进门槛；跑完落 `eval-results/latest.json`——cases 里多了一行 `domain: "investigation"`，报告三维之外新增的域维度自动出现（web 页"有什么渲染什么"，不用改前端）。

## 四、新技术点四要素：缝上记录仪（本票最值的转正手法）

- **名字**：seam 级探针/记录仪（本项目无正式名，先例是票 22 的 UsageProbeLlm——在 LLM seam 上包一层量 token）。
- **作用**：eval 断言"findings 的 evidence 必须逐字来自真实工具输出"，需要拿到**工具原始输出**。麻烦在于票 36 的组链器把循环 observations 封在子图小状态里，只把 `outcome` 并回主状态（`ctx.state.investigation = { outcome }`）——从 run 状态里读不到观察记录。解法不是改生产代码迁就 eval，而是在依赖注入缝（SiemBackend / InvestigationM2 / TriageKb）上包一层"记录仪"：调用照常穿透真件，输出顺手留底。比喻：不给办公室装摄像头（改生产），而是给每个进出的信封各留一份复印件（包 seam）。
- **参数**：记录仪就是被记录接口的手写实现，方法签名一个不变；`toolOutputs: unknown[]` 只增不改。为什么语义等价于"观察 payload 逐字比对"？缰绳检查会证明本 run 没触发 spill/summarize——无治理时观察 payload 就是原始输出本身，两条断言在 happy path 上重合。
- **用法**（evals/src/scenarios.ts，节选）：

```ts
const toolOutputs: unknown[] = [];
const fixtureSiem = new FixtureSiem(FIXTURES_ALERTS);
const siem: SiemBackend = {
  query: async (p) => {
    const out = await fixtureSiem.query(p);
    toolOutputs.push(out);        // 留底
    return out;                   // 穿透，worker 拿到的还是原件
  },
};
// ……断言时：
const outputsText = JSON.stringify(toolOutputs);
const badFindings = report.findings.filter(
  (f) => !executed.has(f.source_tool) || !outputsText.includes(f.evidence),  // 逐字
);
```

## 五、关键顿悟

- **出入记录是合同**：票 14 出入 #1 写"m11 落时搬"，票 42 照单清偿——票据系统的出入与偏差记录不是免责声明，是**挂在账上的债**，体检（G2-8）负责讨债。
- **转正 ≠ 复制粘贴**：票 14 单测直构 `makeInvestigationFlow` 子图入口，这在票 36 之后已是反教材（生产不可达的直构正是 B4 问题）。转正时布景升级成 case_flow 生产入口直拉——考题跟着生产形态走，不跟着历史形态走。
- **case_flow 组链器只回传 outcome**：子图小状态（loop/observations/report）不并回主状态。这是**有意设计**（两个 worker 的 load_case 同名、命名空间防互踩），eval 需要更深的数据就从 seam 取——"断言不够"永远不构成改生产代码的理由。
- **域维是白送的**：报告/前端都没有"investigation"这个硬编码枚举——cases[].domain 就是目录名，"有什么渲染什么"。加域的成本被架构压到了"建一个目录"。

## 六、亲手验证

```bash
cd /Users/divh/Downloads/安全评估agent/soc-demo

# ① 跑 evals 全套（99 条）：应看到 investigation/01_ssh_tp_full [regression,investigation,easy] ✓
pnpm -C evals test 2>&1 | grep investigation

# ② 看报告的调查维：cases 里应有 domain=investigation 一行、passed=true
python3 -c "import json; r=json.load(open('eval-results/latest.json')); \
print([ (c['fullName'], c['passed']) for c in r['cases'] if c['domain']=='investigation'])"

# ③ 只跑调查维：EVAL_TAGS=investigation 走 tag 过滤
EVAL_TAGS=investigation pnpm -C evals test:eval 2>&1 | tail -3
# 应看到：1 ran / 1 passed；报告只剩调查维用例

# ④ 红例自证（防恒绿）：把 test_case.yaml 的 forbidden_tools 加上 siem_query 再跑①，
#    应看到 forbidden_tools 检查红——断言真的会咬人
```
