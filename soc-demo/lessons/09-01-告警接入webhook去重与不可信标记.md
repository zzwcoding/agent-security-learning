# 09-01 · 票 09：m1 告警接入——webhook 正门、去重与不可信标记

## 三问

**位置感**：数据地基（票 03 案件后端）和安全基座（票 04-08 m9 五件套）都齐了，现在
第一滴「真实业务数据」要进系统了：

```
票01 CI守门 ✅ → 票02 票面契约 ✅ → 票03 m2案件后端 ✅ → 票04-08 m9安全基座 ✅
→ 票09 m1告警接入 ✅你在这里 → 票10 m3编排 → …worker/前端/评测
```

- **这一步是干嘛的？** 给系统开一扇「正门」：外部 Wazuh（演示时由 `scripts/replay.ts`
  扮演）把告警 POST 进 `POST /api/v1/webhooks/alerts`，ingest 服务做四步加工——
  接收校验 → 去重 → 映射 → 不可信标记——然后写进票 03 的档案室（m2），档案室同事务
  发一条 `alert.created` 事件。整条链上没有一个 LLM。
- **什么需求逼我们这么设计？** 三个现实麻烦：① 同一条告警 Wazuh 会反复推（每小时
  重报一次暴力破解），不能每推一次建一个案——所以要有去重；② 告警里的日志全文、
  攻击者留的 user agent，全是**敌人写的字**，将来要进 LLM 的 prompt——不标记清楚，
  分诊 agent 就会把日志里的「忽略以上指令」当成真命令；③ 演示需要稳定可复现的
  布景——不能真等黑客来，所以告警必须能从 fixture 文件「回放」出来。
- **解决什么麻烦？** 一次解决三个：去重靠**数据库唯一约束**（不靠应用层查-插，并发
  也兜得住）；不可信字段**入库即盖章**（`untrusted` 标记跟着数据走）；回放脚本走
  同一扇正门——正门有什么闸，回放数据就过什么闸，不存在后门。

## 全链路一览

```
scripts/replay.ts（扮演外部 Wazuh；推模式、不进 compose、绝不碰数据库）
   │  读 fixtures/alerts/*.json，按速率逐个 POST
   ▼
┌─ services/ingest :3001 ──────────────────────────────────────┐
│  ① 接收校验   缺 rule.id / timestamp / 烂 JSON → 422 invalid_alert │
│  ② 映射       wazuh.ts 深模块：Wazuh 方言 → TheHive 方言          │
│     （severity 分带、tags 生成、observables 结构化抽取、整包进 raw）│
│  ③ 不可信标记 full_log/previous_output 进 description 附录段盖章；  │
│     data.* 抽出的 observable 打 untrusted tag                     │
│  ④ 写 M2      M2Client seam → POST case-backend/api/v1/alerts     │
└──────────────────────────────────────────────────────────────┘
   ▼
services/case-backend :3002（票 03 的档案室）
   store.ingestAlert：INSERT … ON CONFLICT(source, source_ref)
   ├─ 新告警 → 建行 + observables + 审计 + outbox[alert.created] → 201
   └─ 重复   → occurrences+1 刷 lastSeen，只记审计、不发事件   → 200
   ▼
GET /api/v1/events?after=   （消费者凭游标领 alert.created——票 10 的编排从这里领活）
```

## 跟着数据走：ssh-5712-real.json 的三进宫

拿最典型的暴力破解告警走一遍（它会被推 3 次，看闸怎么拦）：

1. **第一进宫（新建）**：replay 推 `ssh-5712-real.json`。校验过闸（有 rule.id=5712、
   timestamp 合法）。映射器翻译：`source="wazuh:centos7"`、`sourceRef="1682430696.3725"`
   （去重键=来源+原 id）、`severity=3`（rule.level 10 落在 10-14 带 → High）、
   tags=`[group:syslog, group:sshd, group:authentication_failures, mitre:T1110]`；
   full_log 原文被包进 description 附录段，头上盖 `[untrusted:true field:full_log]`
   的章；`data.srcip` 抽成 `ip` observable、`data.srcuser` 抽成 `other`，都打
   `untrusted` tag；没见过的字段（firedtimes 之类）靠整包 raw 兜底不丢。M2 收到
   INSERT，唯一索引 `(source, source_ref)` 让它一次通过 → **201 dedup=false**，
   同事务发出一条 `alert.created`。
2. **第二进宫（去重）**：同一条又来了。M2 的 INSERT 撞上唯一索引，`ON CONFLICT` 分支
   启动：`occurrences` 从 1 加到 2，`last_seen` 刷成现在；**不建新行、不发新事件**
   （流水线不重复触发——INV-6），但记一条审计 diff（occurrences 变了就是写操作——
   INV-8）→ **200 dedup=true**，ingest 把既有 id 原样退回。
3. **第三进宫**：同上，occurrences=3。此时档案室里 5712 只有一行，outbox 里只有
   一条 `alert.created`——「同一 fixture 连推 3 次只建 1 条」。
4. **捣乱者插队**：他 POST 了一段缺 `rule.id` 的 JSON → 422 `invalid_alert`；
   又 POST 了一段 `{not json` → 还是 422（Fastify 默认 400 被错误处理器盖成契约
   要求的 422）。门的规矩不因人而异。

## 新技术点：SQLite 的 upsert（ON CONFLICT + RETURNING）

- **名字**：UPSERT（`INSERT … ON CONFLICT … DO UPDATE`），SQLite 3.24+ 语法；
  配 `RETURNING` 让写入语句顺手把行吐回来。属于 SQL 标准扩展，better-sqlite3 直接透传。
- **作用**：「不存在就插入，存在就更新」原子化成**一条语句**。和读者已会的
  「先 SELECT 查有没有、再决定 INSERT 还是 UPDATE」相比：两条语句之间有时间缝，
  并发时两个请求可能同时查到「没有」然后都插入——唯一约束能兜底，但代码要处理
  插入失败的分支。upsert 把判断权交给数据库，天生无竞态。
- **参数**：`ON CONFLICT(列…)` 指明撞哪条唯一约束（本项目是票 09 新建的
  `idx_alerts_dedup(source, source_ref)`）；`DO UPDATE SET x = x + 1` 是冲突时的
  改写，`excluded.*` 指代「想插却没插成的那行值」；`RETURNING 列…` 返回改写后的行。
  **判重技巧**：`RETURNING occurrences` 拿回来 >1 就是撞上了（新建恒为 1）。
- **用法**（本项目 case-backend/src/store.ts `ingestAlert`）：
  ```ts
  const row = db.prepare(
    `INSERT INTO alerts (…, occurrences, last_seen) VALUES (…, 1, ?)
     ON CONFLICT(source, source_ref)
     DO UPDATE SET occurrences = occurrences + 1, last_seen = excluded.last_seen
     RETURNING id, occurrences`,
  ).get(/* … */);
  const dedup = row.occurrences > 1;   // 撞唯一索引的就是重复推送
  ```
  教学版选它还有个原因：m1 卡明写「靠数据库约束而非应用层查-插，防并发重复」——
  upsert 就是这句话的标准答案。

## 关键顿悟

- **去重键是 (source, sourceRef)，不是告警内容 hash**。sourceRef 直接用 Wazuh 告警
  自带的 id——上游保证同一事件 id 稳定，比「对 JSON 全文做哈希」便宜且稳（内容里
  一个时间戳变了 hash 就变了，去重反而失效）。TheHive 的原生机制照抄。
- **不可信标记的价值在「下游可自证」**。标记不是给前台看的装饰：full_log 用成对
  文字标记 `[untrusted:true field:full_log]…[/untrusted]` 包进 description，
  data.* 抽出的 observable 打 `untrusted` tag——将来 M4/M5 组 prompt 时 grep 一下
  就能证明「这段是敌人写的」，eval 也能断言标记真的活着。
- **seam 处换 adapter，链路代码零改动**。ingest 只认识 `M2Client` 接口：单测注入
  `MemoryM2Client`（十行 stub），生产注入 `HttpM2Client`（真 fetch）。但 stub 只
  替「链路」，不替「语义」——occurrences+1、唯一约束、单次事件这些**真库行为**
  必须在 case-backend 对真 SQLite 验证，两边测试合起来才是完整证据链。
  测试替身替得越多，谎报平安的风险越大。

## 亲手验证

```bash
cd /Users/divh/Downloads/安全评估agent/soc-demo

# 1. 单测（case-backend 35 + ingest 21）
(cd services/case-backend && npx vitest run)   # 应看到 Tests  35 passed
(cd services/ingest     && npx vitest run)     # 应看到 Tests  21 passed

# 2. 起两个服务（各开一个终端）
(cd services/case-backend && npx tsx src/index.ts)   # :3002，库文件 data/case-backend.sqlite
(cd services/ingest && CASE_BACKEND_URL=http://127.0.0.1:3002 npx tsx src/index.ts)  # :3001
```
```bash
# 3. 第一遍回放：11 条全 201 新建
pnpm replay --rate 20
# 应看到末行：replay done: 11 pushed, 11 created, 0 dedup

# 4. 再回放一遍：11 条全 200 dedup，alert_id 和第一遍完全相同
pnpm replay --rate 20
# 应看到：replay done: 11 pushed, 0 created, 11 dedup

# 5. 单独再推一次 5712，看去重计数和不可信标记
curl -s -X POST http://127.0.0.1:3001/api/v1/webhooks/alerts \
  -H 'content-type: application/json' \
  --data-binary @fixtures/alerts/ssh-5712-real.json
# 应看到：{"alert_id":"…","dedup":true}（还是同一个 id）

curl -s http://127.0.0.1:3002/api/v1/alerts | python3 -m json.tool | grep -E 'occurrences|untrusted'
# 应看到：5712 那条 occurrences=3；description 有 [untrusted:true field:full_log]；
#         ip/other observables 的 tags 里是 ["untrusted"]

# 6. 捣乱实验：故意抽掉 rule.id 再推 → 422
python3 -c "import json;d=json.load(open('fixtures/alerts/ssh-5712-real.json'));d.pop('rule');print(json.dumps(d))" \
  | curl -s -w ' [%{http_code}]' -X POST http://127.0.0.1:3001/api/v1/webhooks/alerts \
    -H 'content-type: application/json' --data-binary @-
# 应看到：{"error":"invalid_alert","details":["[0] rule.id_missing"]} [422]

# 7. 事件流只该有 11 条 alert.created（22 次推送没触发 22 次流水线）
curl -s 'http://127.0.0.1:3002/api/v1/events?after=0&limit=100' | python3 -c "import json,sys;print(len(json.load(sys.stdin)['events']))"
# 应看到：11
```
玩完 `lsof -ti:3001 -ti:3002 | xargs kill -9` 关服务；`rm -f data/case-backend.sqlite*`
重置布景。
