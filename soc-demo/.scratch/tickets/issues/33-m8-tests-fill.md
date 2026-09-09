# 33-m8-tests-fill: 测试补齐：token-ports wire 形 + RealChatLlm 降级（D3）

**What to build:** ① token-ports.ts 契约测试（fetchImpl 注入捕获 /internal/mint 与 /internal/used-tokens 请求 wire 形对齐 gateway 契约，llm-client.test.ts 先例）；② RealChatLlm 两条降级分支行为测试（classify 坏形→unknown 低置信澄清反问；上游病→unknown），knowledge/flow.test.ts:336 先例。

**Blocked by:** （无）

**Touches modules:** `m3`, `m4`, `m8`

**Belongs to spec:** specs/modules.md

**Status:** done

- [x] token-ports 请求 wire 形有测试锁（源：结构-13）
- [x] RealChatLlm 降级分支有行为测试（源：结构-14）
- [x] 既有测试零删除（源：体检口径）

## 实现记录（2026-09-09）

**新增测试两文件（实现代码零改动，既有测试零删除）：**

- `services/agent/src/token-ports.test.ts`（7 测试）：出站 wire 形锁。HttpMintClient/HttpTokenBurner 无构造注入点（直用全局 fetch），打桩走 `web/api.test.ts` 的 `vi.stubGlobal` 先例（捕获先例仍是 llm-client.test.ts 的 url/method/headers/body 五要素）。锁点：铸票两票型请求体 `type` + snake_case 六键逐字 `toEqual` 对齐 gateway `app.py` 的 `body[...]` 取值键（TS camelCase 接口字段 `caseId/runId/allowedTools/approvalId/approvedBy` 在 adapter 映射，与 `gateway/test_mint.py` 请求形状互证）；`caseId null → ""` 空串占位非缺键；非 2xx 抛 `gateway mint failed: HTTP <status>`（同步路径不 fire-and-forget）；env `GATEWAY_URL`/`CASE_BACKEND_URL` 默认目的地；burn 的 `{jti, source}`（缺省 `approval`）+ fire-and-forget 失败只打 `used_tokens_register_failed` 结构化日志不抛。
- `services/agent/workers/chat/llm-real.test.ts`（9 测试）：两条降级分支行为锁。adapter 级（triage/llm-real.test.ts 假 seam 先例）：坏形七样本（非 JSON/缺字段/类型错/截断围栏/数组体）→ `{tool:"unknown", confidence:0, tokens:照记}`；`LlmUpstreamError` 五码 → unknown/0/tokens=0 不抛；非上游错误裸抛（INV-1）；answer 直通 + 上游病原样上抛（回答通道无降级）。全链路级（knowledge/flow.test.ts:336 先例）：真 RealChatLlm 包必抛/坏形 seam 跑真 chat_flow 子图（caseId=null 布景，M2 指向 discard 端口防误触静默）→ completed + 澄清反问 token + 零 tool_call + 审计 `llm_call` 留痕 `unknown/0` + `chat.clarify` 置位——锁住「adapter 降级 → flow.ts:281 消费 → 澄清反问」整条链，不只是 adapter 孤岛。

**变异验证（实测必红后全部还原，git checkout 精确复原）：**

- M1 `token-ports.ts` 铸票键 `case_id`→`caseId`（wire 键漂移）→ token-ports 2 红；
- M2 `llm-real.ts` 坏形降级改「猜」（unknown/0 → siem_query/0.9）→ llm-real 2 红（七样本测试 + 坏形全链路测试）；
- M3 `llm-real.ts` 上游病降级改裸抛（return unknown → throw e）→ llm-real 2 红（五码测试 + 上游病全链路测试）。

**测试**：agent 312+2sk→328+2sk（32→34 文件，零删除）；`python3 tools/check_specs.py` PASS（0 警告）；`pnpm check:boundary` PASS（self-test 17/17，0 越界）；agent `tsc --noEmit`、新文件 eslint 绿。教学 `lessons/33-01-出站wire形锁与fail-closed降级分支.md`。
