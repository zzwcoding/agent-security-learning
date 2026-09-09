# 32-m9-guards-shape-lock: guards 跨语言形状锁 + 注入语料共享锚（D2）

**What to build:** ① fixtures/guards 契约（响应形状 is_injection/score/scanner/action + 通道枚举 alert_field/user_input/kb/tool_output）py/TS 两端测试共读，仿 fixtures/tickets 先例；② fixtures/attack/injection-corpus.json（族→样本→期望命中）共享语料，guards(llm-guard 主路径) 与 mcp-audit(rules.ts) 两套测试同读，锁「同族判定一致」而非合并实现（决策 #11 保持）。

**Blocked by:** （无）

**Touches modules:** `m9`, `m12`

**Belongs to spec:** specs/modules.md

**Status:** done

- [x] guards 响应形状跨语言契约测试（源：对账三-16）
- [x] 注入语料共享锚：两套引擎对同语料族判定一致（源：结构-10）
- [x] 决策 #11（CLI 不依赖运行时 guards）不被破坏（源：PRD 决策记录 #11）

## 实现记录（2026-09-09）

**共享 fixtures（票 02 fixtures/tickets 形态先例，跨语言只走文件、零 import）：**

- `fixtures/guards/contract.json`：`POST /scan/injection` 请求/响应键集（响应六键一字不增不减）、threshold=0.5、scanner 名、通道枚举 alert_field/user_input/kb/tool_output、通道策略 block/block/strip/flag、action 值域四值（fail_closed 注明是 TS 客户端本地合成，不入契约）、client_only 消费契约（consumed_fields + blocked 规则）、2 样本 × 4 通道。`fixtures/guards/README.md` 记密钥外约定与「先改契约再改代码」规矩。
- `fixtures/attack/injection-corpus.json`：6 共有族 → 样本（20 条，hit/miss 语义级期望）→ 两引擎同读同判。mcp_camouflage 刻意不入锚（CLI 特有族）；invisible_chars 语义分叉用宽容锚（样本只取两引擎判定交集的五零宽字符，期望写「含不可见字符→本族命中」不锁计数，JSON 源码用 \uXXXX 转义写不可见字符）；hit 样本钉最小独立分支（多分支样本拆开，见变异 M1 教训）。

**两端测试（4 闸 10 测试，全绿；既有测试零删除）：**

- `services/guards/test_guards_contract.py`（4 测试）：生产端闸——TestClient 真打 HTTP，响应键集/类型/阈值语义/通道策略逐项咬合契约；CHANNEL_POLICY ≡ 契约；缺 channel 必失败。
- `services/agent/src/guards-contract.test.ts`（3 测试）：消费端闸——本地样例服务器按契约回样，断言 scanInjection 映射出的 ScanDecision（blocked 规则 + text 透传 + 请求键集 ≡ request_fields）；SCAN_CHANNELS ≡ 契约 channels；consumed_fields ⊆ response_fields。
- `services/guards/test_corpus_anchor.py`（2 测试）：语料族集 ⊆ py 引擎族集；`_family_hit` 逐族逐样本 ≡ 语料期望。
- `packages/mcp-audit/test/corpus-anchor.test.ts`（1 测试）：scanDescription 逐族逐样本 ≡ 语料期望（≥18 样本防语料掏空）。

**生产者接线（最小类型导出，行为零改动）：** `services/agent/src/guards-client.ts` `ScanChannel` 裸 union 落成运行时 `SCAN_CHANNELS` 数组，类型 `(typeof SCAN_CHANNELS)[number]` 推导（票 31 events.ts 先例，union 值一字不变）。

**变异验证（实测必红后全部还原）：**

- M1 删 py `injection_scan.py` authority_escalation 的「无需(再次)?审批」分支 → py 语料锚红（`auth_hit_zh_norule: 语料期望 hit，py 引擎实判 miss`），mcp-audit 锚绿；
- M2 删 `rules.ts` instruction_override 的「忽略…」分支 → mcp-audit 锚红（`inst_hit_zh: 语料期望 hit，TS 引擎实判 miss`），py 锚绿；
- M3 `injection_scan.py` 响应键 `scanner`→`engine` → py 契约闸红（`响应键集 ≠ 契约（多 ['engine'] / 少 ['scanner']）`），agent 闸绿；
- M4 `guards-client.ts` blocked 规则去掉 `&& action === "block"` → agent 契约闸红（原 guards-client.test.ts 不红——其 mock 恰没覆盖 is_injection=true+strip 组合，契约闸补上该盲区）。

**测试**：guards 13→19 / mcp-audit 13→14 / agent 309+2sk→312+2sk（零删除）；gateway 42 不动。`python3 tools/check_specs.py` PASS（0 警告）；`pnpm check:boundary` PASS（self-test 17/17，0 越界，9/9 禁令有人查——R5 下 mcp-audit 零 import，决策 #11 完好）；`pnpm lint`、agent/mcp-audit `tsc --noEmit` 绿。教学 `lessons/32-01-guards跨语言形状锁与注入语料共享锚.md`。
