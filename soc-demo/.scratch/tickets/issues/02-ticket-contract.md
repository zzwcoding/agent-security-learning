# 02: 跨语言票面契约 fixtures/tickets/

**What to build:** 任务票/ApprovalToken 的固定票面 fixture（合法、过期、scope 不足、参数篡改、已焚毁 jti 五类）+ 期望验票结果表 + 测试密钥约定。py 签发侧与 TS 验票侧的共同"法律"，防两端实现漂移。

**Blocked by:** None (can start immediately)

**Touches modules:** `m9`

**Belongs to spec:** specs/modules.md

**Status:** done

- [x] 五类票面 fixture + 期望验票结果表就位（源：m9 卡 Seam·跨语言共享 fixtures/tickets/ 契约）
- [x] 票面字段照 PRD §5.8/§5.9（jti/sub/case_id/run_id/scope/allowed_tools/iat/exp/sig）（源：PRD §5.8 Ticket / §5.9 ApprovalToken）
- [x] README 写明测试固定密钥与两端消费方式（源：ADR 0001 搬票型不搬代码）

---

## 实现记录（2026-09-08）

**产物**：`fixtures/tickets/`——9 张票面（任务票 5 + ApprovalToken 4，五类映射见下）、
`contract.json`（机读契约：密钥/票型格式/params_hash 规范化/期望验票结果表 9 case）、
`README.md`（密钥约定 + 票型格式 + 冻结时钟 + 两端消费方式）；契约自检测试
`services/gateway/test_ticket_fixtures.py`（8 项，TDD 先红后绿；放 gateway 是因 py
签发侧 pytest 批已存在且被 CI python job 覆盖，票 06/07 在此之上加各自消费测试）。

**五类 × 两票型映射**：合法/过期/已焚毁两类票型各有；scope 不足仅任务票（§5.9 无
scope 字段）；参数篡改任务票=改 payload 不重签（→signature_invalid），ApprovalToken=
签名完好但参数偏离 params_hash（→params_mismatch，INV-2 主教学点）。

**三个契约决策（票 07/06 落地时按此执行）**：
1. **signature_invalid 为 reason 扩展**：PRD FR-S2.2 六种 reason 不含「签名不符」，
   但它是验票第一关（task_token.py 三关之首），fail-closed 必须有名——契约单列
   `signature_invalid`，票 07 需纳入 reason 联合。no_ticket/require_approval 是闸
   控制流，不由票面 fixture 覆盖。
2. **票型 wire 格式 = JWT 三段式**（header.payload.sig-hex，b64url 去 padding，
   json.dumps(ensure_ascii=False) 默认分隔符）——照 task_token.py 逐字节继承
   （ADR 0001）。PRD §5.8/§5.9 JSON 里 sig 在对象内是数据模型示意，非线上形态；
   fixture 同时给 wire token 与解码 payload 两层。
3. **冻结时钟**：fixture iat/exp 为固定历史值，契约测试一律注入 fixture.verify_now，
   禁 wall clock——验票实现须支持注入时钟（票 07 接口签名注意）。

**params_hash 规范化**：`sha256:` + hex(sha256(json.dumps(params, ensure_ascii=False,
sort_keys=True, separators=(',',':'))))，py/TS 双侧写法在 README，fixture 只用扁平
字符串参数（跨语言序列化无歧义的最小子集）。

**验证**：gateway pytest 9 passed（自检 8 + healthz 1）、ruff 全过、TS 三连绿、
spec gate PASS（同票 01 的 6 条规划警告）。
