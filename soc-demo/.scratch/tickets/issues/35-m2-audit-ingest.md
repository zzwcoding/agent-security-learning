# 35-m2-audit-ingest: 审计汇入 M2 一弦：HttpAuditSink + FAILURE 审计 + INV-4 金丝雀（G2-2）

**What to build:** ① worker AuditSink 生产实现换 HttpAuditSink（FR-S5 两路汇入同一 audit_entries 表，票 10 线头）；② ingest webhook 层 FAILURE 审计补齐（票 09-3：畸形/校验失败进审计）；③ evals 补 m9 凭证金丝雀全链路断言（票 08-1：SECRETS 值除出站瞬间外 grep 不到——账面/事件/审计/时间线全可观测面）。

**Blocked by:** 28

**Touches modules:** `m2`, `m3`, `m11`

**Belongs to spec:** specs/modules.md

**Status:** done

- [x] worker 审计五要素落 M2 audit_entries（源：遗留标记 10-1·FR-S5·INV-8）
- [x] webhook FAILURE 审计（源：遗留标记 09-3·PRD S1 异常与边界）
- [x] evals 金丝雀全链路断言（源：遗留标记 08-1·INV-4）

---

## 实现记录（2026-09-09，编码窗口）

**① worker 审计汇入（票 10 线头·FR-S5）**：M2 开出内部审计写口 `POST /internal/audit`
（case-backend app.ts，内网信任口径同 ctxOf；必填缺失/result 白名单外 400 invalid_audit；
store.ingestAuditEntry 落 audit_entries，与 M2 自身 recordAudit 同表同查询面）。agent
`audit.ts` 长出 `HttpAuditSink`（HttpTokenBurner 同款 fire-and-forget 纪律 + `flush()`
排空口仅供测试），五要素 camelCase→snake_case wire 映射在 adapter；`index.ts` 生产装配
`ConsoleAuditSink` → `HttpAuditSink`（降级路径 ConsoleAuditSink 保留，换一行即回）。
**审计失败口径（记票备案）**：业务成功优先、审计失败只打结构化日志
`warn=audit_ingest_failed`——审计通道病了不把业务打死；若 L0 认为审计应 fail-closed，
换补偿式 adapter 即可（调用方零改动），别自行定夺。真 backend 汇入测试：
record → flush → GET /api/v1/audit 按 requestId 查回同一五要素（createdAt 透传调用方
观测时刻）。

**② webhook FAILURE 审计（票 09-3 线头·PRD §6-M1「422 且进审计」后半句）**：
ingest `M2Client` seam 长出 `auditFailure`（HttpM2Client：POST /internal/audit，
action=ingest / actor=m1:ingest / objectType=ingest_request / result=FAILURE，
2s 超时自吞错降级记日志——422 响应绝不被审计可用性劫持；MemoryM2Client 记
auditFailures 供断言）。422 两路都挂审计：校验失败（objectId 尽力取声明告警 id，
取不到 unknown；details.reasons 与 422 响应体同源）与畸形 JSON（objectId=unknown，
原因=解析错误）。正常推送零 FAILURE 审计（SUCCESS 面仍由 M2 写事务负责，不重复记）。

**③ evals INV-4 金丝雀（票 08-1 线头）**：新用例 `attack/11_secrets_canary_fullchain`
（scenario `secrets_canary_fullchain`，scenarios.ts 执行器）：假 SECRETS 值
`canary-vt-key-teaching-fake`（与 compose SECRETS_VT_KEY 教学假值同串）挂布景 env，
跑整条 alert_flow（真 case-backend + FakeTriageLlm + vt-87105），对四个持久可观测面
（run_events / M2 审计全表 / 案件账面 / timeline）grep 金丝雀——占位符 `${{ SECRETS.`
不算泄漏（FR-S1.1 设计即模型只见占位符，持久的是占位符不是值）。防假绿三道：链路必须
真跑出内容（tool_call/M2 审计/verdict 落库在场）、红例注入污染面必须能咬红
（deps.canarySurfaces）、布景后 env 复原。分面词表长出 `credential_boundary`
（types/loader/report 三处 FACETS + 共享样例 fixtures/eval-report/latest.json 补键 +
web FACET_LABELS「凭证边界 INV-4」，两端契约测试同步咬住）。

**待下轮体检补卡**：新端点 `POST /internal/audit` 属「实现长出」——票 31 的
verdict/sse 契约与体检接口对账口径下，m2 卡接口清单未含此端点（Touches m2 已被本票
覆盖），待下轮体检按 C2「补卡未声明接口」先例补卡。

**回归**：先红后绿（四步各自先红：M2 写口 4 测 404 全失败 → 绿；HttpAuditSink 5 测
不存在全失败 → 绿；ingest FAILURE 6 测全失败 → 绿；金丝雀 3 测「未知 scenario」全失败
→ 绿）。全仓 `pnpm test` 绿：**agent 346+1sk（+7 audit.test）/ case-backend 56（+4）/
ingest 37（+6）/ evals 97（+4）/ web 80（不增不减，两处断言随样例同步）/ mcp-audit 14，
零删除**。`pnpm lint` / `pnpm typecheck` 全绿；`python3 tools/check_specs.py` PASS
（0 警告）；`pnpm check:boundary` PASS（0 越界，9/9 条禁令全有人查）。TDD 红灯之外
咬人两处：case-backend 写口首版布尔校验变量让 TS 收窄失效（改谓词早返回）；金丝雀
首测误把 vt_lookup 当分诊工具（它在 m6 富化侧，分诊面是 get_alert/kb_lookup/
search_cases_by_host/create_case/merge_alert/close_alert），按真工具面改断言。

**范围边界**：agent 侧 run_events 的 audit 镜像事件照旧（INV-8 的另一观察面，不动）；
gate/verifyTicket/fetchImpl 等出站 seam 一概不碰；evals 只在豁免清单五文件内组装
（ADR 0003 裁决 3），未触 case-backend db/store 写路径。
