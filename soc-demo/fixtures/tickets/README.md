# fixtures/tickets/ —— 跨语言票面契约

**这是 py 签发侧与 TS 验票侧的共同「法律」**（ADR 0001 后果节：两端共享 HMAC 密钥与
票型，漂移风险用同一组固定票面 fixture + 期望验证结果做跨语言契约测试对冲）。
票面字段照 PRD §5.8 Ticket / §5.9 ApprovalToken；验票 reason 对位 PRD FR-S2.2 的
`verifyTicket` 契约；焚毁语义对位 CONTEXT.md INV-2。

## 清单

```
fixtures/tickets/
├── README.md                  ← 本文件：密钥约定 + 两端消费方式
├── contract.json              ← 机读契约：密钥/格式/规范化规则/期望验票结果表
├── task-ticket/               ← 任务票（PRD §5.8，TTL 900s，决策记录 #3）
│   valid · expired · scope-insufficient · payload-tampered · burned
└── approval-token/            ← ApprovalToken（PRD §5.9，TTL 300s）
    valid · expired · params-tampered · burned
```

五类票面 × 期望验票结果（机读版在 contract.json `cases`，两端测试以它为准）：

| 类 | 任务票 fixture | ApprovalToken fixture | 探针 | 期望 |
|---|---|---|---|---|
| 合法 | valid | valid | 对 scope 内工具 / 原参数 | **allow** |
| 过期 | expired | expired | 同上，verify_now 越过 exp | 403 `token_expired` |
| scope 不足 | scope-insufficient | —（§5.9 无 scope 字段） | 工具 ∉ allowed_tools | 403 `scope_insufficient` |
| 参数篡改 | payload-tampered（票体改 case_id 不重签） | params-tampered（签名完好，参数偏离 hash） | 改动后的载荷 | 403 `signature_invalid` / `params_mismatch` |
| 已焚毁 jti | burned | burned | jti 已入 used_tokens 后重放 | 403 `token_used`（INV-2） |

`no_ticket` / `require_approval` 是验票闸的控制流（没带票 / L2 无审批铸票），不是票面
状态，不由本目录 fixture 覆盖——它们在票 07 的闸测试里。

## 测试固定密钥

```
value    = soc-demo-test-hmac-key-do-not-use-in-prod
encoding = UTF-8 原始字节（无 hex 解码、无 KDF）
alg      = HMAC-SHA256
```

唯一机读源是 `contract.json` 的 `hmac_key`（测试从这里读，不要在代码里复制字符串）。
**仅限测试**，任何真实环境引用此值都算事故。

## 票型格式（继承 starter-agent/task_token.py，ADR 0001「搬票型不搬代码」）

```
wire   = <b64url(header)>.<b64url(payload)>.<hex(hmac_sha256(key, "b64h.b64p"))>
b64url = 去 padding；payload 序列化 = json.dumps(ensure_ascii=False)（默认分隔符）
header = {"alg":"HS256","typ":"JWT"}
sig    = hex 摘要（教学变体，非 JWT 标准的 base64url 段）
```

PRD §5.8/§5.9 的 JSON（sig 在对象里）是数据模型示意；线上形态以本契约为准——
sig 在第三段，payload 内不含 sig。字段集：任务票
`jti/sub/case_id/run_id/scope/allowed_tools/iat/exp`，ApprovalToken
`jti/approval_id/approved_by/tool/params_hash/case_id/iat/exp/used`，一字不增不减
（自检测试锁死）。

`params_hash` 规范化（跨语言必须逐字节一致）：

```python
# py
"sha256:" + hashlib.sha256(json.dumps(params, ensure_ascii=False, sort_keys=True,
                             separators=(",", ":")).encode()).hexdigest()
```
```js
// TS（node:crypto）
"sha256:" + createHash("sha256").update(JSON.stringify(
  Object.fromEntries(Object.entries(params).sort()))).digest("hex")
  // 注意：JSON.stringify 无空格，与 py separators=(',',':') 对齐；值为字符串时等价
```

## 冻结时钟（fixture 永不过期的关键）

所有票面的 iat/exp 是**固定历史值**；`合法` 类的 exp 早已是过去时。契约测试一律用
fixture 的 `verify_now` 作为「当前时间」注入验票实现，**禁止读 wall clock**。
因此验票实现必须支持注入时钟（如 `verifyTicket(toolCall, ctx, now = Date.now())`）。

## 两端消费方式

- **py 签发侧（gateway，票 06）**：`services/gateway/test_ticket_fixtures.py` 是契约
  自检（已存在，别删）；铸票实现落地后在同目录加消费测试——对每张 fixture 跑自己的
  解码/验签路径，断言 `expected`。签发确定性建议：冻结 iat + 固定 jti 时，铸票输出
  必须与 fixture token 逐字节一致。
- **TS 验票侧（agent，票 07）**：`services/agent/` 下加契约测试，`node:crypto` 的
  `createHmac("sha256", Buffer.from(key, "utf8")).update(unsigned).digest("hex")`，
  b64url 解码用 `Buffer.from(seg, "base64url")`；遍历同一 `contract.json` 断言同一
  `expected` 表。六种 403 reason 之外还有本契约的 `signature_invalid`（见下）。
- **两端都不许重签 fixture**——它们是历史文物，只验不铸；要造新票面走票 06 的铸票
  实现并补进契约表 + 自检。

## reason 枚举与一处显式扩展

`contract.json.reasons` = PRD FR-S2.2 的六种 403 + `allow` + **`signature_invalid`**。
扩展原因：签名不符不在 PRD 六种 reason 里，但它是验票第一关（task_token.py 三关之
首），fail-closed 语义下必须有个名字——契约把它单列，票 07 落地时纳入 reason 联合。
此决策记录自票 02 实现记录。

## 改契约的规矩

改任何 fixture / contract.json，必须同时让 `services/gateway/test_ticket_fixtures.py`
8 项自检全绿（签名咬合、字段集、TTL、时钟窗、探针、期望表、焚毁说明）。生成器脚手架
不在仓库里——契约的唯一真相是这批 JSON + 自检测试。
