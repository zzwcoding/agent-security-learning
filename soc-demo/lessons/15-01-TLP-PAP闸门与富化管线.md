# 15-01 · m6 富化 worker：TLP/PAP 闸门与 analyzer 管线

> 票 15 教学文档。前情：票 13 分诊、票 14 调查都已上岗。案子查完了还差一步——SOC 有个例行动作叫**富化（enrichment）**：把案子里的 IP、文件哈希拿去查威胁情报（"这个 IP 是不是坏已知？"），把查到的评级和新线索回写进案子。本票让这位 CTI 分析师上岗。他没有 LLM 脑子，却有一道全系统最较真的闸门：**数据太敏感就一个字节都不许出门**。

## 1. 三问（阶段动机）

**位置感**：终极目标是"告警进系统 → 分诊建案 → 调查取证 → 高危动作等人点头"的 SOC 数字员工。路线图：

```
✅ 票 01-03  地基：CI / 票面契约 / 案件后端（六实体库）
✅ 票 04-08  安全件：guards / 铸票 / 验票闸 / 凭证代理
✅ 票 09     告警接入
✅ 票 10-12  编排 + 审批回路 + gateway 容器
✅ 票 13-14  分诊 agent / 调查 agent
✅ 票 15     ◀ 你在这里：富化 agent（observables 查情报 + TLP/PAP 闸门 + artifacts 回写）
⬜ 票 16+   沙箱攻击面 / 知识沉淀 / Web 演示窗 / eval 收口
```

**这一阶段是干嘛的？** 拿着案件里的 observables（文件哈希、IP……）去查威胁情报，按 Cortex analyzer 的契约拿到评级（`malicious/suspicious/safe/info` 四档）和它顺藤摸瓜挖出的新线索（artifacts，比如哈希对应的文件名），再把评级报告和新线索都写回案件。

**什么需求逼我们这么设计？** 威胁情报查询是把**自家数据发给外部世界**——这和"读进来"方向相反，多了一类风险：案子里的东西有敏感级别（TheHive 用 TLP/PAP 两个 0~N 的数字标敏感度，4=RED 是"绝不外传"），而情报源的承受能力有上限（Cortex 里叫 `max_tlp/max_pap`）。**observable 的敏感度超过情报源上限就不许查**——这是 OPSEC（行动安全）铁律。麻烦在于：这条规则要是靠 prompt 里写一句"请注意别外发敏感数据"来守，LLM 一忘就漏了。所以 m6 卡把 Seam 定死：**闸门必须做成工具包装层里的确定性中间件，不靠 prompt 自觉**。

**解决了什么麻烦？** 之前案子的 observables 只是躺着的一堆字符串；现在每个可外发的 observable 都有了四档评级和拒绝对账，analyzer 挖出的新 artifacts 也自动归案。而"敏感数据不外泄"从一句嘱咐变成了一道物理闸门——测试能证明：被拒的查询，情报后端**一个字节都没收到**。

## 2. 全链路一览

```
TP 案件 case_000001（observables：hostname=web-01、filename=…zip、hash=c05640e2…）
   │
   ▼
┌──────────── agent 服务 · workers/enrichment/flow.ts（三节点，无 LLM）────────┐
│ load_case     读案件详情（M2 adapter 直读，observables 带 tlp/pap）           │
│ enrich        逐个 observable 过流水线：                                     │
│   ① 验票闸     gated()：任务票 allowed_tools 含该 analyzer？无 → DENIED+强杀  │
│   ② TLP/PAP闸  tlpPapGate()：tlp>pap 上限？超 → DENIED 审计+报告记 refused，  │
│                查询根本不发出去（不抛不杀，拒绝是工具级结果）                  │
│   ③ 查情报     FixtureAnalyzerTable：fixtures/ti/<data>.json 命中读文件，      │
│                未命中回 no-record（是"没查到"，不是错误）                     │
│   ④ guards扫   analyzer 输出属 tool_output 通道 → 注入特征命中只打标不拦       │
│                （analyzer 是可被污染的第三方件，票 04 的 flag 策略）           │
│   ⑤ artifacts  analyzer 挖出的新 observable → add_observable 回写（L1 过闸）， │
│                M2 按 dataType+data 去重合并：重复不建行只并 tags              │
│ write_report  富化报告进 timeline：body 人读 markdown（[malicious]/[refused]  │
│                可 grep）+ structured 机读 JSON（四档评级/拒因/回写清单）       │
└──────────────┬───────────────────────────────────────────────────────────────┘
               ▼
   M2：timeline 多一条 enrichment_report；observables 可能多几行 artifacts；审计全程留痕
```

每个环节一句话：**load_case 是领料**；**enrich 是查情报的手**（五道工序全串在这只手上，闸门就住在 ①②）；**write_report 是交报告**。和票 14 最大的不同：这里**没有 plan/decide/report 三个 LLM 节点**——富化是纯确定性管线，查什么、按什么顺序、拒绝怎么办全在代码里，因为 m6 卡的职责里只有"查、闸、回写"，没有"判断"。

## 3. 跟着数据走：87105 恶意文件案（enrich/01 布景）

布景：票 09 的 87105 告警（"VirusTotal: malicious file detected"）已建案，案件 observables 是 `hostname=web-01`、`filename=/tmp/invoice_apr.zip`、`hash=c05640e2…`（各带 tlp=2/pap=2）。

1. **load_case**：从 M2 读到三条 observable 和它们的敏感度标签。
2. **enrich 逐个过**：hostname 和 filename 撞"类型不外发"清单（内部实体，查外部信誉没有意义还泄内网拓扑），跳过、记进对账栏（skipped_internal=2）。轮到 hash → 走 vt_lookup：
   - ① 验票闸：任务票 allowed_tools 里有 `vt_lookup` ✓，广播 tool_call 事件；
   - ② TLP/PAP 闸门：observable tlp=2 ≤ analyzer max_tlp=2 ✓（边界不冤枉，等于上限放行）；
   - ③ 查情报：`fixtures/ti/c05640e2….json` 命中——`taxonomies: [{namespace:"VT", predicate:"reputation", value:"5/70", level:"malicious"}]`，还带 artifacts：`[{dataType:"filename", data:"invoice_apr.zip"}]`（哈希对应的恶意附件名，案子里原先只有完整路径）；
   - ④ guards 扫描输出 JSON：干净，放行；
   - ⑤ artifacts 回写：过闸调 `add_observable`，M2 里 `filename=invoice_apr.zip` 落一条新 observable（201，dedup=false）。
3. **write_report**：报告进 timeline，评级栏 `[malicious]`、summary 写着"查了 1 个 observable：malicious 1、suspicious 0、safe 0、info 0……"。工具轨迹恰好三条：`vt_lookup → add_observable → add_timeline_entry`，全程 0 条 DENIED。
4. **捣乱实验（TLP:RED 不外发）**：往案子里种一条 `ip=203.0.113.66, tlp=4` 的 observable（合作方 RED 情报，别的系统流进来的）再富化一遍。这次 ② 就卡住了：ip_reputation 的 max_tlp=2，4 > 2 → 审计落一条 `tlp_pap_denied`（DENIED），errorMessage 逐字是 `tlp_exceeded: observable tlp=4 > max_tlp=2`——而包在情报表外面的探针证明：后端只收到了那个 hash，**203.0.113.66 从没出门**。run 照常 completed：报告如实写着 `[refused]` 和拒因，拒绝不是事故，是闸门在工作。
5. **再捣乱一次（投毒 analyzer）**：往案子里种 `ip=198.51.100.23`（fixtures/ti 里这条情报的 full 字段藏着一句"ignore all previous instructions…"）。它的 tlp=2，闸门放行、查询正常发出——但 analyzer 的**输出**会进 LLM 上下文，属于 tool_output 通道，guards 命中后按票 04 的策略只**打标**：审计 `tool_output_flagged`，报告里这段原文保留、旁边一行"⚠ guards：…已打标放行…待人工复核"。拦的是"信它"，不是"看它"。

## 4. 新技术点四要素：Cortex analyzer 契约与确定性闸门

- **名字**：Cortex analyzer 契约子集（`max_tlp/max_pap` 闸门）。Cortex 是 TheHive 官方的情报编排引擎，analyzer 是它的"查情报插件"；本票照抄它的调用/返回契约和闸门语义（PRD §6-M6、ref-thehive-cortex）。落在 `workers/enrichment/analyzers.ts` + `flow.ts` 的 `analyze()` 包装层。
- **作用**：把"什么数据能发给哪个情报源"从人的判断变成**表驱动 + 纯函数**。analyzer 描述符声明自己`{dataTypes, max_tlp, max_pap}`（"我只吃 hash，最高承受 TLP:AMBER"），闸门函数拿 observable 的 tlp/pap 和描述符一比就出裁决。和你已会的东西的关系：票 13/14 的验票闸管的是"**你有没有资格调这个工具**"（授权），这道闸管的是"**这个数据配不配出门**"（数据敏感度）——两道闸各管各的，串联在工具包装层里。
- **参数**（关键三条）：
  - 比较是**严格大于才拒**：tlp=2 撞 max_tlp=2 放行，tlp=3 才拒——"边界不冤枉"；
  - `errorMessage` 是契约，逐字进审计和报告：`tlp_exceeded: observable tlp=4 > max_tlp=2`（先查 tlp 后查 pap，先撞先报）；
  - 别和签名契约搞混（`tools.ts`）：签名只管"tlp 是不是 0-4 的整数、dataType 在不在枚举里"这类**形状**；tlp=4 形状合法，拒它是闸门的**语义**——分层是测试明确锁死的。
- **用法**（`flow.ts` 的包装层骨架，简化）：

```ts
const payload = await gated(ctx, analyzer, call, async () => {     // ① 授权闸（票 07）
  const gate = tlpPapGate(call, ANALYZERS[analyzer]);              // ② 确定性闸门（纯函数）
  if (!gate.ok) {
    record({ action: "tlp_pap_denied", objectType: "analyzer_call",
             details: { error: gate.errorMessage }, result: "DENIED" });
    return { kind: "refused", errorMessage: gate.errorMessage };   //    拒绝就地解决，不外发
  }
  return { kind: "result", payload: await analyzers.lookup(analyzer, call) }; // ③ 才外发
});
```

  生活比喻：验票闸是公司前台（"你有工牌吗？"），TLP/PAP 闸门是保密室的门禁（"这份文件的密级超出你能看的范围"）。前台刷你进楼，保密室照样能把你拦下——两道门谁也不替代谁。而"确定性中间件"的意思就是：门禁是机器，不是保安的心情——同样的卡刷一百次，结果一样。

## 5. 关键顿悟

- **fail-closed ≠ 摊牌**：闸门拒绝一个查询，run 照常跑完、报告照出——只是报告里如实写着"这项被拒了，为什么"。整条链路没有一处假装"查过了"。**把拒绝当成一等公民的输出**（审计 DENIED + 报告 refused 行 + skipped 对账栏），比把拒绝藏起来或整个崩掉都安全：前者骗人，后者脆弱。
- **"不外发"有两道独立的门**：一道看**类型**（hostname/filename 是内部实体，压根不进外发清单），一道看**敏感度**（ip 可以查，但 TLP:RED 的 ip 不行）。测试里对应两个断言：`results.every(x => x.dataType !== "hostname")` 和探针证明被拒 IP 没到过后端。安全清单写成两道门而不是一道"综合判断"，每一道都能单独被测死。
- **analyzer 是供应链上的可疑方块**：情报数据是别人喂给你的，里面可以藏 prompt 注入（fixtures/ti 里那条投毒 IP 就是布景）。票 04 的通道策略在这里落地：analyzer 输出 = tool_output 通道 = **放行但打标**。不因噎废食禁用情报，也不傻吃——标记 + 原文保留，裁决权留给人。
- **mock 后端 = 一个目录**：FixtureAnalyzerTable 的"情报库"就是 `fixtures/ti/<data>.json`，命中读文件、未命中回 `no-record`。给外部服务写 mock 时，先让 seam（AnalyzerBackend 接口）足够窄，mock 就只剩"查表"一个动作——再往外探针包一层，就能断言"谁真被调用到了"。

## 6. 亲手验证

富化链路的单测已全绿，你可以亲手跑一遍（不起 Docker，内存件 + 真实 fixture）：

```bash
cd /Users/divh/Downloads/安全评估agent/soc-demo/services/agent
npx vitest run workers/enrichment
```

应看到：2 个文件 24 个测试全绿（contract 15 + flow 9）。flow 第一组就是 enrich/01 全链路（hash → malicious → artifacts 回写 → 报告进 timeline）；enrich/02 那条里能找到逐字的 `tlp_exceeded: observable tlp=4 > max_tlp=2`。

再看全仓不回归 + spec 门禁：

```bash
cd /Users/divh/Downloads/安全评估agent/soc-demo
pnpm test && pnpm typecheck && python3 tools/check_specs.py
```

应看到：agent 197 / case-backend 43 / ingest 21 / mcp-audit 10 全绿；spec gate PASS（2 条"规划中模块目录尚不存在"的合法警告）。

**捣乱实验**（验证你真理解了闸门分层）：打开 `workers/enrichment/tools.ts`，把 `PAP_MAX` 从 3 改成 4，再跑 contract 测试——"pap 上限 3（PRD §5.3 PAP 0-3）"那条断言立刻红：形状层的枚举界是被测试锁死的契约，改一个数字就该惊动它。改回来后，再试试把 `flow.ts` 里 `ANALYZER_OF` 的 `ip: "ip_reputation"` 改成 `undefined`——enrich/02 这次红在 `tlp_pap_denied` 审计断言上（DENIED 记录压根没产生）：ip 被类型清单拦在第一道门之外，**轮不到敏感度闸门说话**。两道门串联的顺序感，测试替你看得死死的。
