# 31-m3-sse-verdict-contract: SSE 事件类型 + verdict 词表双端契约锁（D1）

**What to build:** ① SSE SseEventType 全集（agent 产出 vs web 消费 vs CHAT_WIRE_TYPES 子集）建共享契约测试，加事件不同步必红；② verdict 词表四处（triage prompt/schema、M2 store、web 颜色映射）建值域包含断言（TO_M2_VERDICT 值域 ⊆ M2 VERDICTS）。

**Blocked by:** （无）

**Touches modules:** `m3`, `m4`, `m10`

**Belongs to spec:** specs/modules.md

**Status:** ready-for-agent

- [ ] SSE 契约测试双端共读同一 fixture/常量（源：对账三-14·结构-3）
- [ ] verdict 词表契约测试（源：结构-4）
- [ ] 既有测试零删除（源：体检口径）
