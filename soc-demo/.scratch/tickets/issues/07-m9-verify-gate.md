# 07: m9 TS 验票闸：verifyTicket 中间件

**What to build:** agent 侧 TS 中间件：verifyTicket(toolCall, ctx) → allow|403+reason。校验签名/exp/scope/allowed_tools/case-run 绑定/参数 hash，查 used_tokens 焚毁表。TS 侧契约测试全过同一组票面 fixture。

**Blocked by:** 02, 03

**Touches modules:** `m9`

**Belongs to spec:** specs/modules.md

**Status:** done

- [x] 六种 403 reason：no_ticket/scope_insufficient/token_expired/token_used/params_mismatch/require_approval（源：PRD FR-S2.2·m9 卡公开接口）
- [x] 已焚 jti 重放第二次 403 token_used（源：m9 卡测试计划·INV-2）
- [x] 伪造审批文本（消息里"已批准"无 token）→ 403（源：m9 卡测试计划·INV-9）
- [x] TS 侧对 fixtures/tickets/ 契约测试全过（与 py 侧同一组）（源：m9 卡 Seam）
- [x] 验票延迟实测 ≤5ms（源：m9 卡测试计划）
- [x] 验票服务自身异常一律 403（源：INV-1 fail-closed）

---

## 实现记录（2026-09-08）

**产物**：`services/agent/src/verify-ticket.ts`（验票闸本体：`verifyTicket(toolCall, ctx,
nowSec, opts)` + `paramsHash()` + `MemoryBurnRegistry` 内存焚毁表适配器）+
`verify-ticket.test.ts`（26 测试对位 6 验收条目）。未动 app.ts/路由——闸的挂点在
LangGraph 工具调用封装层，票 10（编排骨架）接线；本票交付独立可测的闸函数。

**契约消费**：按 contract.json `cases` 遍历九张 fixture（五类票面），逐张注入
`verify_now` 冻结时钟 + 按 `burn` 节造重放现场，断言 expected 表全过——与 py 铸票侧
`test_ticket_fixtures.py`（8 自检）+ `test_mint.py`（票 06）同一组数据两端互证。
params_hash 跨语言锚点（`{host:"web-01"}` → `sha256:b8dc6b29…` 即 approval-token/valid
票内指纹；嵌套键序 + 非 ASCII + 空参三例）由 py 同参计算的期望值锁死在测试里。

**实现取舍（按票面/m9 卡落地，未改 spec 本体，记录判断依据）**：
① ctx 传票的 **wire 原串** 而非 PRD 接口草图的 Ticket/ApprovalToken 对象——README
明文「PRD §5.8/§5.9 的 JSON 是数据模型示意，线上形态以本契约为准」，闸必须拿到原始
字节才能真验签；
② `now` 参数用 **unix 秒**（iat/exp 同域，默认 `Math.floor(Date.now()/1000)`），
README 示例的 `Date.now()` 是毫秒示意，秒制避免与 fixture 纪元混单位；
③ case/run 绑定失配与审批票工具失配（`payload.tool ≠ toolCall.name`）均归
**scope_insufficient**——FR-S2.2 六种 reason 无专名，绑定/scope 同属「票的适用范围」；
工具比对是 py `verify()` 没做的 TS 闸侧补强（py 只管契约消费路径），在 FR-S2.2
「校验 scope、allowed_tools」文义内；
④ fail-closed 桶的 reason 定为 **signature_invalid**（contract.json reasons_note 明文：
它是 fail-closed 第一关的单列名）；焚毁表查询抛异常/密钥缺失/参数无法序列化同归此桶；
⑤ 工具分级用**最小静态表**（L0 siem_query/kb_search、L2 isolate_host/kb_write、未知
工具按 L1=fail-closed）只为产出 no_ticket/require_approval 控制流，FR-S2.1 的
ToolManifest 机制归后续票；
⑥ 焚毁表 seam 是同步 `has(jti)` 读口（内存适配器供测试），生产写侧走票 03 的
`POST /internal/used-tokens`（M2 同库同事务审计）——闸只读不写，「用后」才焚毁。

**验证**：agent vitest 33/33（本票 26 + 原有 7）、全仓 TS 测试 74/74（case-backend 30、
mcp-audit 10、ingest 1）、gateway pytest 回归 17/17（票02 自检 8 + 票06 8 + healthz）、
`pnpm lint` 过、`pnpm typecheck` 4 包过、`python3 tools/check_specs.py` PASS（5 条规划
警告，m4-m7/m11 目录未建，与本票无关）。延迟实测（2000 次/路径冻结时钟热循环）：
task_ticket avg=0.0121ms、approval_token avg=0.0100ms，预算 ≤5ms 余量约 400 倍。
TDD 红灯记录：首版 `if (ctx.ticket)` 真值判断把空串票 `""` 误报成 no_ticket，改
`typeof === "string"` 分支后全绿（教训进 lessons）。教学文档
`lessons/07-01-验票闸verifyTicket.md`。
