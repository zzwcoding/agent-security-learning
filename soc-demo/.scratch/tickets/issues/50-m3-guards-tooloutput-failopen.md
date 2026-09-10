# 50-m3-guards-tooloutput-failopen: guards 不可达时 tool_output 通道静默 fail-open（P2）

**What to build:** 修复防线缺口：guards 服务停机时，分诊/调查/富化的 `tool_output` 扫描通道**静默放行**——不打标、不审计、无任何降级痕迹，run 照常 completed。现状：`guards-client.ts` 不可达时按 failMode 缺省 block 返回 `fail_closed` 裁决，但 tool_output 的两个消费点只认 `flag` 分支，`fail_closed`（以及 `block`）落空即放行。本票让"降级"变成**看得见的事件**：无论选哪种修法，guards 不可达时必须有可 grep 的审计/事件痕迹。

**缺口解剖（2026-09-10 场景教学 2.2 捣乱实测发现）：**
- 位置①（裁决生产侧）：`services/agent/src/guards-client.ts:47-49` —— failMode 缺省 `block`；`unreachable()` 把不可达折成 `fail_closed`（guards-client.ts:74-82）。
- 位置②（裁决消费侧，只认 flag）：`services/agent/workers/investigation/flow.ts:229-240`（observe 的扫描消费）、`services/agent/workers/enrichment/flow.ts:175-185`（analyzer 输出扫描消费，同款）。
- 对照组（合规样板）：triage（workers/triage/flow.ts:99 一带）与 chat（workers/chat/flow.ts:10 一带）的 prompt 侧通道**显式处理 block/fail_closed**——仅工具输出通道漏。
- 实证：同一案件直拉 case_flow，guards 在线 → 工具输出含真注入样本、flag 1 次打标+审计；guards 停机 → 0 flag、0 审计、0 事件、run completed（教具 run：在线 run_572f5bec vs 停机 run_ce0559ef）。

**修法二选一（记票交 L0 裁决，实现前定案）：**
- **方案 a（推荐）**：tool_output 扫描的调用点显式传 `failMode:"flag"`——不可达时 guards-client 返回 `{action:"flag", reason:"guards_unreachable"}`，沿用既有 flag 打标语义（原文保留待人工复核），消费点把 reason 写进审计 details。最小改动、语义自洽（工具输出通道本来就是 flag 策略，票 04）。
- **方案 b**：消费点显式处理 `fail_closed`——记 `guards_unreachable` 降级审计（FAILURE）+ run 事件 warning，行为与现状一致（不打标放行）但留痕。改动集中在两个 worker。

**边角（随本票一并处理）**：flag 打标路径取 `decision.score`；方案 a 下不可达 flag 的 `score` 为 undefined——details 需缺省化（如 `score: decision.score ?? null`）或以 reason 替代。

**Blocked by:** （无——票 04 guards 通道、票 43 共享出站骨架均已落）

**Touches modules:** `m3`, `m5`, `m6`

**Belongs to spec:** specs/modules.md

**Status:** done

- [x] guards 停机 + 直拉 case_flow：审计或 run 事件里出现具名降级痕迹（`guards_unreachable`），不再静默 completed（源：lessons/scenario/2-2.md 捣乱 A/B 对照；总纲「发现的问题」P2）
- [x] guards 在线行为回归：tool_output 注入样本照旧 flag 打标 + `tool_output_flagged` 审计（对照 run_572f5bec 形态），triage/chat prompt 通道行为零变化（源：票 04 策略表；对照组合规）
- [x] 不可达路径 `score` 边角处理：details 无 undefined 字段（缺省 null 或以 reason 替代）（源：本票边角）
- [x] 单测补不可达注入用例（guards-client 假件停机 → 断言降级痕迹 + 不强杀 run），既有测试零删除（源：阶段纪律「测试零删除」）
- [x] 复跑教学对照（docker compose stop guards → 直拉 case_flow → 对比 A/B）作为验收冒烟，结果回写 lessons/scenario/2-2.md 备注行（源：教学布景可复现性）

## 备注

- 优先级 P2 依据：这是**安全相关通道的可观测性静默缺失**（防线在但降级无痕），不是数据损坏/越权——故不阻塞教学，转票排期。
- 修复后 2-2.md 的 A/B 教具对比会变成"A flag / B 降级留痕"，教学叙事更完整。

## 实现记录（2026-09-10）

**定案**：方案 a（L0 已裁决）。guards-client 本体**零改动**——`unreachable()` 的 flag 路径本就返回 `{action:"flag", reason}`（票 43 的 reason 分类口径：连接拒绝/解析失败=`guards_unreachable`、出站 2s 超时=`guards_timeout`），缺的只是消费点显式传 `failMode:"flag"` 和 details 兜底。

**落点**：
- `services/agent/workers/investigation/flow.ts`：observe 的扫描调用点显式传 `{ failMode: "flag" }`——不可达折成 flag 打标裁决走同一打标语义（原文保留待人工复核），不再按缺省 block 折成 `fail_closed` 被落空即放行；`tool_output_flagged` 的审计 details 与 SSE audit 事件都加 `reason: decision.reason ?? null`，`score` 改 `decision.score ?? null`（不落 undefined 字段，JSON 序列化不丢键）；`scan` dep 签名放宽为 triage `ScanFn` 同款三参形态 `(text, channel, opts?)`（生产装配件传的 `scanInjection` 本就是三参，零适配）。
- `services/agent/workers/enrichment/flow.ts`：analyzer 输出扫描消费点同款三件（显传 failMode / details 加 reason / score ?? null），`scan` dep 签名同款放宽。
- 未动：triage/chat prompt 通道、guards 服务本体、failMode 缺省值（其它通道不受影响）、run-kinds.ts 装配（`scan: scanInjection` 原样兼容）。

**测试（TDD 先红后绿，零删除）**：
- `src/guards-client.test.ts` +1：不可达 + `failMode:"flag"` → 断言返回形状恰为 `{blocked:false, action:"flag", reason:"guards_unreachable"}` 且 `score` 为 undefined（closed port → 连接拒绝 → `guards_unreachable`）。
- `workers/investigation/flow.test.ts` +1：注入不可达-flag 假 scan → run completed 且 failReason null、消费点收到 `{failMode:"flag"}`、每条成功观察带 flagged、审计 details `toMatchObject({reason:"guards_unreachable", score:null})` 且序列化后 `toHaveProperty("score", null)`（区分 undefined 丢键）。
- `workers/enrichment/flow.test.ts` +1：同款（rig 增 scan 覆写注入点，本就缺——顺带补上）；另断言富化报告结果项 `flagged:true` 原文保留。
- 红灯确认：两个 worker 用例实现前失败于 `expected undefined to match object { failMode: 'flag' }`（恰证明消费点此前不传 opts）。

**门禁**：`cd services/agent && pnpm test` → **486 passed | 3 skipped（47 文件）**（基线 483 passed | 3 skipped，+3 新用例零删除）；`pnpm typecheck`（tsc --noEmit）过；soc-demo 根 `pnpm lint`（eslint services packages evals）过。记一笔：`workers/triage/accuracy.test.ts` 的横断用例（基线实测 4821ms/限 5000ms）在全量并行跑下偶发压线超时，属预存边缘（单独跑必过，与票 50 改动无涉——triage 路径零改动），复跑全绿。

**实机冒烟（compose 真件，agent 镜像重建后复跑）**：
- A（`docker compose stop guards` → 直拉 case_000002）：`run_bd705abd` **completed（steps=2）**，审计 4 条打标不再静默：
  `tool_output_flagged|SUCCESS|{"tool":"siem_query","channel":"tool_output","score":null,"reason":"guards_timeout"}`（related_alerts / kb_verify / ip_reputation 同款 3 条；SSE audit 事件镜像同痕迹）。
- B（`docker compose start guards` 恢复后复拉）：`run_29386723` completed，注入样本照旧 `tool_output_flagged … {"score":1,"reason":null}`——在线行为回归过（对照 run_572f5bec 形态 + 新增 reason 字段非降级时为 null）。
- guards 已恢复：`curl :8001/healthz` → `{"ok":true,"service":"guards"}`，容器 healthy。
- 对照结果回写 lessons/scenario/2-2.md 文末备注（引用块，注明「票 50 修复后复跑 A/B：停机不再静默」），原文零改动。

### 记票定夺（票面留白处 / 交 L0 备案）

1. **冒烟里 reason 是 `guards_timeout` 不是 `guards_unreachable`**：compose 网络里 `stop` 掉的容器丢包不回话 → 出站 2s 超时 → 按票 43 口径归 `*_timeout`；`*_unreachable` 是连接拒绝/解析失败分支（guards-client 单测用 closed port 锁定该分支返回 `guards_unreachable`）。两条标签同出一条 flag 降级路径，票面验收项的「具名降级痕迹」满足——具名、可 grep、指认「扫描器不在场」；不为凑字面改票 43 的分类口径。2-2.md 备注里已向学习者解释这对标签。
2. **enrichment rig 顺带补 scan 注入点**：票面只要求用例，但 enrichment 测试 rig 原本没留 scan 覆写（investigation 有）——补齐属测试基建，不触生产码。
3. **SSE audit 事件镜像同步加 reason/score ?? null**：票面只点名审计 details；事件镜像带着同一份打标痕迹一起兜底，避免「details 是 null、事件里丢键」的序列化分裂。
