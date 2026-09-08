# 06: m9 铸币 py 件：POST /internal/mint

**What to build:** gateway 自写 FastAPI 的铸币端：task_token.py 票型（HMAC-SHA256 自签）签任务票与 ApprovalToken。py 侧契约测试全过 fixtures/tickets/。

**Blocked by:** 02

**Touches modules:** `m9`

**Belongs to spec:** specs/modules.md

**Status:** done

- [x] POST /internal/mint 签任务票/ApprovalToken（源：m9 卡公开接口·PRD §6-M9）
- [x] 票型 HMAC-SHA256 + scope + exp + 任务绑定，TTL 900s（源：ADR 0001·决策记录 #3）
- [x] py 侧对 fixtures/tickets/ 五类票面契约测试全过（源：m9 卡 Seam·票 02 产物）
- [x] ApprovalToken 绑定参数 hash，改参数即失效（源：PRD FR-S2.2·INV-2）

---

## 实现记录（2026-09-08）

**产物**：`services/gateway/`——`mint.py`（铸币车间：任务票/ApprovalToken 签发 +
py 侧解码/验签路径 `verify()`，票型照 ADR 0001「搬票型不搬代码」继承 task_token.py
的 wire 形态 `<b64h>.<b64p>.<hex(hmac_sha256)>`，b64url 去 padding、payload
`json.dumps(ensure_ascii=False)` 默认分隔符、字段集照 PRD §5.8/§5.9 一字不增不减
且**键序固定**——签发确定性：冻结 iat + fixture claims 可逐字节复现 fixture token，
有测试锁死）、`app.py`（薄装配层：`POST /internal/mint` 收 type task_ticket/
approval_token，密钥读 env `SOC_HMAC_KEY`，缺失拒绝铸票 fail-closed；票型未知/
缺字段 400）、`test_mint.py`（8 测试对位 4 验收条目）。

**契约消费**：`verify()` 按 contract.json clock policy 显式注入 `now`、按 fixture
`burn` 登记造重放现场，九张 fixture（合法/过期/scope不足/参数篡改/已焚毁jti 五类）
逐张跑解码/验签路径断言 expected，全过；票 02 自检 `test_ticket_fixtures.py` 八项
原样未动全绿。`verify()` 仅 py 侧契约消费与圆 trip 自测用，生产验票闸在 TS 侧
agent（票 07 verifyTicket，含 no_ticket/require_approval 控制流与 case/run 绑定）。

**源标注出入（记票不猜，未改 spec/票面验收）**：验收条目 2 标注「ADR 0001·决策
记录 #3」——ADR 0001 的决策 #3 是工作量估计；「Ticket TTL 统一 900s」实为 PRD
文末《附：待定项决策记录》#3（§5.8 注释亦引它）。要求本身无歧义（ADR 0001 盘点
行 + PRD 决策 #3 合起来恰是本条验收），按此实现。

**验证**：gateway pytest 17/17（票02 自检 8 + 票06 8 + healthz）、guards 回归 9/9、
ruff（guards+gateway）过、spec gate PASS（5 规划警告，与本票无关）；真服务冒烟
:8002：healthz ok、铸 ApprovalToken 返回三段式 token，其 params_hash 与
approval-token/valid fixture 逐字节同（同参数必同指纹），改 host=web-02 再铸指纹
整串变。教学文档 `lessons/06-01-mint铸票.md`。
