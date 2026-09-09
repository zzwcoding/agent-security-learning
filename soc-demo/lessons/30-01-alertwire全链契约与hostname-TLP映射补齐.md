# 30-01 · 票 30：alert wire 全链契约——hostname/TLP 补进映射，一条告警三段同锁

## 三问

**位置感**：阶段 7 收官体检回补波的第四票，还是"数据形状契约没有机器锁"这条线：

```
票29 latest.json 双端契约（evals↔web）✅ → 票30 alert wire 三段同锁（ingest↔M2↔agent）
✅你在这里 → 票31 SSE/verdict 词表锁（排着队）
```

- **这一步是干嘛的？** 补 m1 映射表的两行欠账，再给整条告警流水线上一把"逐字段
  对暗号"的锁。欠账是体检 G1 收回来的两条遗留标记：① ingest 映射一直没抽
  `agent.name → hostname`，导致"同主机 24h 只建 1 案"的归并（FR-M2.4）对回放数据
  永远空转——分诊想按主机归并，可告警里根本没带主机这张名片；② TLP 被硬编码成
  `tlp: 2`，无论告警盖什么章，进案一律"琥珀"，票 15 的 TLP:RED 富化闸门演示只能
  直插数据库种数据才能演。
- **什么需求逼我们这么设计？** 体检 A3 实锤：ingest→M2→agent 三段各自都有本地
  测试，但**链条上没有一把共同的锁**——三段各自"对"各自的，接口形状漂移只有等
  它真咬人了（hostname 缺口就是这么咬的）才知道。
- **解决什么麻烦？** 以后谁改告警 wire 形状（比如把 `sourceRef` 改名、把
  observables 的结构动了），一个测试文件直接红，红在三段里的哪一段就修哪一段；
  不用等"FR-M2.4 怎么对真实数据不管用了"这种跨票悬案再开一轮体检。

## 全链路一览

```
fixtures/alerts/ssh-5712-real.json          ← 锚：具名 fixture（真 Wazuh 形态）
        │  POST（webhook 正门，绝不直塞库）
        ▼
ingest 子进程 services/ingest/src/index.ts  ← ① 段：真 mapWazuhAlert 映射
        │   wazuh.ts：抽 hostname（agent.name）、tlpFromAlert 溯源（新！）
        │   observables 每条继承告警级 tlp（新！）
        ▼
case-backend 子进程 :随机端口                ← ② 段：REST 存取形状
        │   POST /api/v1/alerts → SQLite → GET /api/v1/alerts/:id
        │   mapAlert 的 camelCase wire：sourceRef/verdictAi/occurrences/…
        ▼
HttpTriageM2（agent 生产 adapter）           ← ③ 段：消费形状
            getAlert → AlertDto 逐字段（triage flow 的 hostOf 就认这里的 hostname）
            findActiveCases(host) → FR-M2.4 归并；createCase → observables 随案
```

测试放在 `services/agent/workers/triage/wire-contract.test.ts`——因为第③段的
HttpTriageM2 是 agent 的源码，测试必须住在它家里；①②两段用**子进程起真服务**
（票 28 的先例），跨服务只走 HTTP，谁也不 import 谁的源码（边界规则 R1）。

## 跟着数据走：一条 TLP:RED 告警的进案之旅

用新具名 fixture `vt-87105-malware-tlp-red.json`（VT 恶意文件告警，rule.groups
里多了个 `tlp:red` 章）：

1. **进正门**：POST 到 ingest 的 `/api/v1/webhooks/alerts`，201 拿回
   `{alert_id, dedup:false}`。单条/批量、缺 rule.id 报 422，这些闸都在映射之前。
2. **映射（wazuh.ts）**：`tlpFromAlert` 认出了 groups 里的 `tlp:red` → tlp=4
   （过去这里写死 2）。抽 observables 时 `agent.name → hostname` 排在首位（新），
   `syscheck.path → filename`、`sha256_after → hash` 照旧，且**每条 observable
   都继承告警的 tlp=4**（新）——这一步是 TLP 能"随管道走"的关键：光改告警级的
   tlp，富化闸门（它读的是 observable.tlp）还是看不见。
3. **落库（M2 REST）**：ingest 的 HttpM2Client 把映射结果 POST 给 case-backend，
   GET 回来时形状是 mapAlert 决定的：`sourceRef`（不是 source_ref）、`verdictAi`
   （不是 verdict_ai）、`occurrences: 1`、tags 数组原样、observables 带
   `tlp: 4`——这些键名拼写就是 wire 契约本体，测试逐字段锁。
4. **消费（agent）**：HttpTriageM2.getAlert 把 REST 响应当 AlertDto 读。分诊
   flow 的 `hostOf()` 在 observables 里找 `dataType === "hostname"` 找到了
   `web-01`——归并查询终于有主机可查：`createCase` 之后
   `findActiveCases("web-01", 24)` 能命中，case 标题也是
   `[wazuh_alert] - web-01 - 2023-04-25`（primary entity 认 hostname，不再是
   sourceRef 兜底）。

再拿 `ssh-5712-real.json`（没盖 TLP 章）走一遍：`tlpFromAlert` 三条规则全落空 →
默认 2，和改造前行为一模一样——这就是"既有 21 个测试语义保持"的原因。

## 新技术点四要素：`tlpFromAlert` 的抽取规则（记票口径）

- **名字**：`tlpFromAlert(w)`——services/ingest/src/wazuh.ts 导出的纯函数（照
  `severityFromLevel` 先例，导出就是为了单测能逐条打规则表）。
- **作用**：把"告警上盖过的 TLP 章"翻译成 TheHive 5.2 后口径的 0-4 整数。PRD
  §5.1 只写了"默认 2/2"，没给字段映射，所以本票按票面授权自定规则并**记进票面**
  （这本身就是契约：以后 PRD 若补映射表，以 PRD 为准回改这一个函数）。
- **规则（优先级从高到低）**：
  1. 显式字段 `rule.tlp` 是 0-4 界内整数 → 直接用（Wazuh 规则自定义字段盖章）；
  2. 否则扫 `rule.groups` 和 `rule.description` 里的 `tlp:<色|数字>` 标记
     （大小写不敏感；white|clear→0、green→1、amber→2、amber+strict→3、red→4），
     多个命中取最严（fail-closed：宁可高保不高外流）；
  3. 都没有 → 默认 2（PRD §5.1）；非法值（`tlp:9`、`tlp:redis`）不算数，落默认。
- **用法**：
  ```ts
  const tlp = tlpFromAlert(o);          // mapWazuhAlert 里调用
  // …
  tlp,                                                   // 告警级
  observables: extractObservables(o).map((ob) => ({ ...ob, tlp })),  // 逐条继承
  ```
  正则里 `amber+strict` 必须排在 `amber` 前面（正则交替从左到右，先长后短）；
  `\b` 词边界挡住 `tlp:redis` 这种假命中。

## 关键顿悟

- **"能同时 import 到三段"的地方不存在，就用"子进程 + HTTP 对活"**：边界规则
  R1 禁止跨服务 import 源码，所以没有任何一个测试文件能同时摸到 mapWazuhAlert
  和 HttpTriageM2。解法不是破例，是把三段全拉到"活的公开 REST 面"上对质——
  测试住在消费方（agent）家里，生产方（ingest、case-backend）用子进程起真件。
  这样锁住的是**真映射**的输出，而不是测试替身的输出。
- **票 13 留下的那行"建议补一行映射"其实值三行**：hostname 是一行；但 TLP 若只
  改告警级，enrich/02 布景还是进不了案——闸门读的是 observable.tlp，所以
  "observables 继承告警 tlp"这半句才是"不再需 DB 直种"的落点。改映射前先把
  下游**到底读哪个字段**查清楚，欠账才还得完整。
- **测试替身会先于生产代码"修正"，这是它的特权也是它的风险**：testkit 的
  alertInputFromWazuh 在票 13 就自作主张补了 hostname（不然分诊测试没法写），
  副本和真映射从此各走各的。本票真映射补齐后，用 wire 契约测试把两边"对活"
  锁住，副本注释也改指票 30——替身可以先行，但欠条要记在票面上，终有一天要还。

## 亲手验证

```bash
cd /Users/divh/Downloads/安全评估agent/soc-demo
pnpm -C services/ingest test      # 31 passed（21 旧 + 10 新：hostname/TLP 规则表）
pnpm -C services/agent test       # 304 passed | 2 skipped（含 wire-contract 2 测试）
pnpm -C services/agent exec vitest run workers/triage/wire-contract.test.ts
                                  # 单跑全链契约：2 passed，~1.5s（起两个子进程）
python3 tools/check_specs.py      # spec gate: PASS（0 警告）
pnpm check:boundary               # self-test 17/17 + boundary gate: PASS
```

捣乱实验（做完记得还原）：把 `services/ingest/src/wazuh.ts` 里的
`push("hostname", agent.name, "agent.name", false)` 注释掉，再跑上面第三个命令
——wire 契约测试红在"hostname 进案"那一行（unit 测试也红），还原后全绿。这就是
"回放流水线再丢主机名片时必红"的手感。
