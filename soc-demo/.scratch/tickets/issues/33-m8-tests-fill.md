# 33-m8-tests-fill: 测试补齐：token-ports wire 形 + RealChatLlm 降级（D3）

**What to build:** ① token-ports.ts 契约测试（fetchImpl 注入捕获 /internal/mint 与 /internal/used-tokens 请求 wire 形对齐 gateway 契约，llm-client.test.ts 先例）；② RealChatLlm 两条降级分支行为测试（classify 坏形→unknown 低置信澄清反问；上游病→unknown），knowledge/flow.test.ts:336 先例。

**Blocked by:** （无）

**Touches modules:** `m3`, `m4`, `m8`

**Belongs to spec:** specs/modules.md

**Status:** ready-for-agent

- [ ] token-ports 请求 wire 形有测试锁（源：结构-13）
- [ ] RealChatLlm 降级分支有行为测试（源：结构-14）
- [ ] 既有测试零删除（源：体检口径）
