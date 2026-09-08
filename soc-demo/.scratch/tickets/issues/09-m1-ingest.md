# 09: m1 告警接入 + 回放载体

**What to build:** webhook 接收 → 去重（occurrences+1）→ 映射 → 不可信标记 → 写 m2 → 发事件。scripts/replay.ts 扮演外部 Wazuh 按速率回放 fixture。

**Blocked by:** 03

**Touches modules:** `m1`, `m2`

**Belongs to spec:** specs/modules.md

**Status:** done

- [x] POST /api/v1/webhooks/alerts 全链路：接收校验→去重→映射→不可信标记→写 m2→发事件（源：m1 卡职责·内部结构）
- [x] 同一 fixture 连推 3 次只建 1 条，occurrences+1 刷新 lastSeen（源：m1 卡测试计划·INV-6）
- [x] 7 类具名 fixture 映射全过（源：m1 卡测试计划）
- [x] 注入变体字段带 untrusted 标记（源：m1 卡测试计划）
- [x] scripts/replay.ts：推模式、不进 compose、绝不直塞数据库（走 webhook 正门）（源：m1 卡回放载体三条铁律）

---

## 实现记录（2026-09-08）

**产物**：
- `services/ingest/src/wazuh.ts`——深模块：接收校验（缺 `rule.id`/`timestamp` → details）、
  severity 分带映射（PRD §5.1：0-4→1，5-9→2，10-14→3，15+→4）、tags 生成
  （`group:*` + `mitre:*`）、observables 结构化抽取（data.srcip→ip、data.srcuser→other、
  data.url→url、syscheck.path→filename、md5/sha1/sha256/hash 字段→hash）、不可信标记
  （full_log/previous_output 用成对标记 `[untrusted:true field:X]…[/untrusted]` 包进
  description 附录段；data.* 抽出的 observable 打 `untrusted` tag）、未知字段整包进 raw。
- `services/ingest/src/m2client.ts`——出站 seam（m1 卡「真实 HTTP / 内存 stub」）：
  `M2Client` 接口 + `HttpM2Client`（fetch → POST case-backend `/api/v1/alerts`，
  201=新建 / 200=去重）+ `MemoryM2Client`（单测 stub，按 (source,sourceRef) 计数）。
- `services/ingest/src/app.ts`——webhook 正门：单条/批量（FR-M1.1）、畸形 JSON 与
  校验失败一律 422 invalid_alert（盖掉 Fastify 默认 400）、去重结果透传（不在本服务
  查表，唯一约束兜底在 M2）。
- `services/case-backend/src/{db,store,app}.ts`（m2 侧增量）——alerts 表加
  `occurrences`/`last_seen` 列 + 唯一索引 `idx_alerts_dedup(source, source_ref)` +
  旧库迁移；`store.ingestAlert` upsert（`ON CONFLICT DO UPDATE … RETURNING`，
  occurrences>1 即判重）：新建=行+observables+审计+outbox[alert.created]，重复=
  occurrences+1 刷 lastSeen、只记审计 diff、**不发事件**；REST `POST /api/v1/alerts`
  新建 201 / 重复 200。
- `scripts/replay.ts` + 根 `pnpm replay`——推模式回放 CLI（`--url/--dir/--rate`），
  只 POST webhook，不 import 任何库件；docker-compose.yml 无 replay 服务（三铁律有
  机器断言：replay.test.ts）。
- `fixtures/alerts/` 11 个 fixture——7 具名（5710/5712/554/510/87105/31101/31103）
  + 4 注入变体（载荷植入 srcuser/full_log/url/UA 四位，FR-M1.7）。
- 根 package.json：`type: "module"`（scripts/ 下 TS 用 import.meta 需要）+ tsx devDep +
  `replay` 脚本。

**测试**：case-backend 35（新增 5：upsert 新建/连推 3 次 occurrences 1→2→3+lastSeen
刷新/单次事件/审计 diff/REST 201→200）；ingest 21（severity 全带、5712 契约示例映射、
raw 留存、observable 抽取、untrusted 标记、校验 details、全链路 dedup、畸形 JSON 422、
批量、HttpM2Client 真 HTTP、三铁律静态断言、7 具名 fixture 映射表、4 注入变体、
replay 端到端推活服务）。全仓 `pnpm lint/typecheck/test` 绿；spec gate PASS；
真服务冒烟：两遍 replay（11 created → 11 dedup 同 id）+ 第三次单推 5712
occurrences=3 + outbox 恒 11 条 alert.created + 审计 create/update 序列核对后清库。

**契约裁决**：
- 去重判定在 M2（撞唯一索引），ingest 只透传 dedup——m1 卡内部结构的「去重」步骤
  物理上落在 M2 SQLite（卡备注原文），ingest 保持无状态。
- `occurrences` 的审计：重复推送记 `update` 条目（INV-8「occurrences 变了就是写
  操作」）；不发 `alert.created`（PRD 异常与边界「去重冲突不产生新事件」）。
- 注入变体四位置中 UA 只存在于 full_log（web 访问日志的 User-Agent 段），故与
  full_log 变体同走 description 附录段标记；srcuser/url 走 observable tag。

**出入记录（spec/卡与实现的出入，未改 spec 本体，待总窗口裁决）**：
1. **fixtures/alerts 原本为空**：PRD C10 要求「7+ 类真实 Wazuh 告警落盘」，但无任何
   票负责造 fixture。本票补齐 11 个：5712 用 PRD §6-M1 契约示例原文；5710/554/510/
   87105/31101/31103 的 description/level 按 Wazuh 官方规则集查证口径手造
   （5710=sshd 不存在用户 L5、554=FIM 文件新增 L7、510=rootcheck 异常 L7、
   87105=VirusTotal 恶意文件 L12、31101=web 400 L5、31103=web CGI 500 L6），
   **非官方 logtest 原文**。真容器 logtest 属 FR-M1.6 可选真实模式，不在本票验收内。
2. **m1 卡公开接口列了 `POST /internal/replay {fixture_dir, rate}`**，但同卡备注
   2026-09-04 定案回放载体 = `scripts/replay.ts`（推模式、不进 compose 的非运行时件；
   ingest 本身在 compose 里，挂这个端点即与定案冲突）。按票面与定案实现 replay.ts，
   该内部端点未做。
3. **PRD §6-M1 异常与边界「畸形 JSON → 422 且进审计（result: FAILURE）」**：422 已做；
   FAILURE 审计需要 ingest 把失败写进 M2 审计表（新增内部写口），超出本票验收条目，
   暂缓——下游票若需审计守门再补。
4. **PRD「事件总线不可达 → pipeline_pending + 重试 + 死信」**：本实现事件与告警同
   SQLite 事务落 outbox（票 03 机制），「总线不可达」在架构上不存在；pipeline_pending
   标记与死信队列未做，属 outbox 模式对该异常的覆盖性替代。
