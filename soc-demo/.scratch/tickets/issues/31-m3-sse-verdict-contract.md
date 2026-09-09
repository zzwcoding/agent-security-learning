# 31-m3-sse-verdict-contract: SSE 事件类型 + verdict 词表双端契约锁（D1）

**What to build:** ① SSE SseEventType 全集（agent 产出 vs web 消费 vs CHAT_WIRE_TYPES 子集）建共享契约测试，加事件不同步必红；② verdict 词表四处（triage prompt/schema、M2 store、web 颜色映射）建值域包含断言（TO_M2_VERDICT 值域 ⊆ M2 VERDICTS）。

**Blocked by:** （无）

**Touches modules:** `m3`, `m4`, `m10`

**Belongs to spec:** specs/modules.md

**Status:** done

- [x] SSE 契约测试双端共读同一 fixture/常量（源：对账三-14·结构-3）
- [x] verdict 词表契约测试（源：结构-4）
- [x] 既有测试零删除（源：体检口径）

## 实现记录（2026-09-08）

**共享样品（fixtures/，票 29「样品即契约」先例，三端互不 import 源码——R1 边界下唯一通道）：**

- `fixtures/sse-events.json`：`event_types` 全集 11 值 + `chat_wire_types` 对话子集 7 值，附 note 记两端消费方式与子集语义。
- `fixtures/verdicts.json`：`tri_verdicts`（fp/btp/tp/uncertain）+ `to_m2_verdict` 翻译表 + `m2_verdicts`（M2 值域 4 值）。

**生产者接线（行为零改动，只让词表可测）：**

- `services/agent/src/events.ts`：`SseEventType` 裸 union 落成运行时 `SSE_EVENT_TYPES` 数组，类型改 `(typeof SSE_EVENT_TYPES)[number]` 推导（union 值一字不变）——类型是编译期注记，测试摸不到；数组才是可共读的运行时事实。
- `services/agent/src/app.ts`：`CHAT_WIRE_TYPES` 从 buildApp 函数体内挪到模块顶层并 export（名单是静态词表，模块作用域本就是它的家）。
- `services/web/src/pages/AlertsPage.tsx`：`VERDICT_COLORS` 加 export。

**契约测试（10 闸，全绿）：**

- `services/agent/src/sse-contract.test.ts`（2 测试）：agent 全集 ≡ 样品；chat 子集 ≡ 样品且 ⊆ event_types、无重复。
- `services/agent/workers/triage/verdict-contract.test.ts`（3 测试）：TriVerdict 键集 ≡ VERDICT_VALUES ≡ 样品 tri_verdicts；TO_M2_VERDICT 逐键值 ≡ 样品；值域 ⊆ 样品 m2_verdicts。
- `services/case-backend/src/verdict-contract.test.ts`（2 测试）：M2 VERDICTS ≡ 样品 m2_verdicts；样品翻译表值域 ⊆ VERDICTS（TO_M2_VERDICT 值域包含的 M2 侧对称闸——写回不被 store 拒收）。
- `services/web/src/sse-verdict-contract.test.ts`（3 测试，`?raw` 共读，票 29 先例）：web SSE_EVENT_TYPES ≡ 样品；VERDICT_COLORS 覆盖 m2_verdicts 全集；颜色表键集恰好 = m2_verdicts + tri 短别名（错别字键静默无色的闸）。

**变异验证（TDD 变异必红，全部实测后还原）：**

- agent events.ts 加 `"thinking"`（样品/web 不动）→ agent sse-contract 红、web 绿；
- 样品同步加 `"thinking"`（web 不跟）→ **web 对端红**（`expected […9] to deeply equal […10]`），agent 转绿；
- case-backend `VERDICTS` uncertain→unknown → M2 侧两测红；
- agent `TO_M2_VERDICT` fp→"false_pos" → triage 侧映射比对 + 值域包含两测红；
- web 颜色表混入 `_DEAD` 键 → web 键集闸红。

**测试**：agent 304+2sk→309+2sk / case-backend 50→52 / web 77→80（零删除；ingest 31、evals 93/31 用例不动）。全仓 `pnpm test` 绿，`python3 tools/check_specs.py` PASS（0 警告），`pnpm check:boundary` PASS（self-test 17/17，0 越界），`pnpm lint`/`pnpm typecheck` 绿。教学 `lessons/31-01-SSE事件与verdict词表-共享样品契约锁.md`。
