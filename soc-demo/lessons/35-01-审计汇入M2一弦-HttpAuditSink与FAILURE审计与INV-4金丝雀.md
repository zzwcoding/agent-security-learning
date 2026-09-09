# 35-01 · 票 35：审计汇入 M2 一弦——HttpAuditSink + FAILURE 审计 + INV-4 金丝雀

## 三问

**位置感**：阶段 7 体检 G 组清偿波第二票（上一票 G2-1 焚毁读口已清）：

```
体检 G2 线头清单：G2-1 焚毁读口 ✅已清 → ✅你在这里 G2-2 审计汇入（四个线头捆一票）
→ G2-3 run 异步化 → G2-4 ToolManifest → ……
```

这一票捆了**四个线头**：票 10 的 HttpAuditSink（等 M2 开写口）、票 09-3 的 webhook
FAILURE 审计、票 08-1 的 evals 金丝雀复跑、票 21-② 的「DENIED 审计只进 console」。
四个线头其实是同一句话的四块碎片——**PRD FR-S5「两路汇入同一张 audit_entries 表」**
一直只兑现了一路。

- **这一步是干嘛的？** 把审计的「账本」从各服务自己的小本本（console 日志、内存
  数组）换成**案件后端的一张总表**。此前 M2 的 `audit_entries` 只有查询面
  （GET /api/v1/audit）没有写入口，agent 的生产审计只能打进 compose 日志
  （ConsoleAuditSink），ingest 收到畸形告警时 422 了但审计表里**一个字都没有**。
- **什么需求逼我们这么设计？** INV-8 说「任何写操作/审批/拒绝都要有五要素审计」，
  INV-4 说「真凭证只活在网关 env 与出站那一瞬间」。审计如果散在各个服务的日志里，
  「查一次审计」= 登录 N 个容器 grep N 份日志；只有汇入**同一张表**，审计才是
  可查询、可对账、可被 INV-4 金丝雀 grep 的「真相源」。
- **解决什么麻烦？** 三件事一次收口：① worker 的审计条目（含 DENIED）真落总表；
  ② webhook 拒收畸形告警时总表里有 FAILURE 记录可查（安全事件的「拒之门外」
  留痕）；③ evals 有一条常驻金丝雀用例，谁要是把 SECRETS 值写进了任何持久面，
  CI 当场报红。

## 全链路一览

```
【汇入路 1：worker 审计（票 10 线头）】
  agent worker/REST 任何需要审计的时刻
      └─► audit.record(五要素)  （AuditSink seam，票 10 立的口，调用方零改动）
            ├─ 测试/evals：MemoryAuditSink（内存数组，断言用）
            └─ 生产：HttpAuditSink（票 35 新增）
                  fire-and-forget POST case-backend /internal/audit
                  失败只打 warn=audit_ingest_failed 日志，绝不阻塞业务
                      │
【汇入路 2：webhook FAILURE（票 09-3 线头）】        ▼
  ingest 收到畸形 JSON / 校验失败            case-backend POST /internal/audit（票 35 新开）
      └─ 422 invalid_alert（老行为不变）            │ 薄口：必填+result 白名单校验
          └─ 同时 m2.auditFailure(...) ────────────► store.ingestAuditEntry
                                                      ▼
                                        audit_entries 表（总账本，INV-8 真相源）
                                                      │
                                        GET /api/v1/audit（老查询面，不加区分）
                                                      ▲
【守夜人：INV-4 金丝雀（票 08-1 线头）】              │
  evals attack/11：假 SECRETS 值挂 env → 跑整条 alert_flow →
  grep 四个持久面（run_events / M2 审计 / 案件账面 / timeline）→ 有值即红
```

## 跟着数据走：一条 DENIED 审计的进账之旅

拿「分诊 worker 被注入攻击、guards 拦下」的真实场景走一遍：

1. **五要素在 worker 手里成形**：`{ action: "guards_block",
   actor: { type: "agent", id: "agent:triage" }, objectId: "run-x",
   objectType: "run", details: { reason, channel }, requestId, result: "DENIED",
   createdAt }`。这就是审计的「五要素」：谁（actor）、对什么（object）、干了什么
   （action）、结果（result）、哪次请求（requestId）——加一个 details 快照。
2. **adapter 换制服不换人**：`HttpAuditSink.record()` 把 camelCase 映射成 snake_case
   wire（`objectId→object_id`、`requestId→request_id`、`createdAt→created_at`）——
   case-backend 按 `body["object_id"]` 这些键取值，映射错一个键就是 400。
   record() 同步返回、发送在后台跑：审计慢一拍没关系，业务一步都不能等。
3. **M2 薄口验货进账**：`POST /internal/audit` 查必填四项（action/object_id/
   object_type/request_id）+ result 只许 SUCCESS/FAILURE/DENIED，过了就交
   `store.ingestAuditEntry` INSERT 进 audit_entries——和 M2 自己业务写事务里的
   recordAudit **同一张表**，查询面不加任何区分。
4. **查询面对账**：`GET /api/v1/audit?requestId=req-35-audit-1` 查回这一条，
   result=DENIED、createdAt 还是 worker 观测的那一刻——审计测试就是这么钉的：
   record → flush → REST 查回同一五要素。

**捣乱输入走一遍（webhook FAILURE 路）**：攻击者 POST 一段 `"{not json"`——
Fastify 解析炸出 SyntaxError → 老逻辑盖成 422 invalid_alert；新逻辑在回 422 的
**同时**向 M2 报一条 `{ action: "ingest", actor: m1:ingest, objectId: "unknown",
result: "FAILURE", details: { reasons: [解析错误] } }`。总表里从此有这一行：
谁在什么时候从正门扔了什么垃圾、被哪道闸拦的。注意 **422 还是 422**——审计挂了
（M2 不可达）也只是本地多一行 warn 日志，绝不把 422 劫持成 500。

## 新技术点四要素：金丝雀断言（canary assertion）

- **名字**：金丝雀断言（canary），安全测试行话。名字来自矿工带金丝雀下井探毒气——
  放一个「应该永远不被感知的值」进系统，它在哪里出现，哪里就在漏。
- **作用**：INV-4 这类「负面不变量」（某值永远不许出现在某处）没法用「检查功能
  对不对」的正向断言锁住——你必须**主动埋一个假值、然后到处找它**。和单元测试的
  区别：它锁的不是「做了对的事」，而是「没做坏的事」。
- **参数**（本票用法，scenarios.ts 的 `scenarioCredentialCanary`）：
  - 假值要与生产注入串**同形同串**：`canary-vt-key-teaching-fake` 就是 compose 里
    `SECRETS_VT_KEY` 的教学默认值——快道布景挂 env、全栈道网关 env 真注入，
    断言语句一个字不用改；
  - **扫面要枚举持久面**：run_events（SSE 补发的落盘总线）、M2 审计全表、案件账面、
    timeline。占位符 `${{ SECRETS.` **不算**泄漏——FR-S1.1 的设计就是让模型只见
    占位符，持久的是占位符不是值；
  - **防假绿三件套**：链路必须真跑出内容（面是空的，grep 干净没有证明力）；
    红例注入污染面必须能咬红（证明断言不是恒绿）；布景结束 env 复原（金丝雀只在
    布景里活一瞬间）。
- **用法**（最小骨架）：

```ts
process.env.SECRETS_VT_KEY = "canary-vt-key-teaching-fake"; // 埋
try {
  await runAlertFlow();                                    // 跑
  const leaks = Object.entries(surfaces)
    .filter(([, v]) => JSON.stringify(v)?.includes(CANARY)).map(([k]) => k);
  // 断言：leaks 必须为空，且链路真跑出过内容
} finally {
  restoreEnv();                                            // 复原
}
```

本项目落点：`evals/src/scenarios.ts` 的 `scenarioCredentialCanary` + 用例
`fixtures/eval/attack/11_secrets_canary_fullchain/`。沙箱场景早有一只同款鸟
（scenarios.ts 的 `SOC_CANARY_SECRET`，探 VM 内 env 可见性），本票补的是 m9 凭证
代理链路的那只——票 08 只把它锁到了网关单测层。

## 关键顿悟

1. **「汇入同一张表」的重点在「同一张」，不在「写进去」**。审计散在各服务日志里，
   每条都存在但谁也查不了；汇入一张表后，INV-8 从「每处都有留痕」升级成「一处可
   对账」，INV-4 的金丝雀也才有固定的 grep 面（扫一张表 vs 登 N 个容器）。
2. **fire-and-forget 与 fail-closed 是一对反向旋钮，拧哪个要看 seam 的角色**。
   焚毁**读**口（票 34）在执行裁决路径上，查不到真相必须 fail-closed；审计**写**口
   （本票）是旁路记账，通道病了只降级记日志——把业务打死才是更大的安全事故。
   两个 adapter 长得几乎一样，方向完全相反，这正是 seam 立着的意义。
3. **负面不变量要配「活体证据」**。断言「X 处处不在」最怕两种假绿：面是空的
   （链路没跑，当然找不到）、断言恒绿（写错了永远通过）。解法永远是加**正交的
   活性证明**：链路产出计数 + 一条能咬红的反例。

## 亲手验证

```bash
cd /Users/divh/Downloads/安全评估agent/soc-demo
```

1. **看总账汇入**：起 compose（或本机 `pnpm -C services/case-backend dev`）后跑一条
   告警，然后 `curl -s 'http://127.0.0.1:3002/api/v1/audit' | python3 -m json.tool | grep -A3 '"result": "DENIED"'`
   ——应看到 worker 汇入的 DENIED 条目（actor 是 `agent:…`），和 M2 自己写的
   create/update 条目混在同一份清单里，形状无差别。
2. **看 FAILURE 进账**：`curl -s -X POST http://127.0.0.1:3001/api/v1/webhooks/alerts -H 'content-type: application/json' -d '{bad'`
   ——应得 422；紧接着 `curl -s 'http://127.0.0.1:3002/api/v1/audit?objectId=unknown'`
   ——应看到一条 `action: "ingest"`、`result: "FAILURE"`、actor `m1:ingest` 的记录。
3. **捣乱实验（金丝雀咬人）**：把 evals 里 `canaryLeaks` 的判断临时改成恒 false
   （或把 `surfaces` 少传一个面），跑 `pnpm -C evals vitest run src/scenarios.test.ts`
   ——红例测试和防假绿断言应当场报红；改回来再跑应全绿。这一步验证的是
   「断言真的能咬人」，不是背预期输出。
