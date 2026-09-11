# 57-jiaotu-llm-ticket-channel: 狗粮票 A · LLM+票务通道改走椒图（m9 外部化第一拍）

**What to build:** 默认形态零变化的前提下，把 soc-demo 的 LLM 出站与票据申领/焚毁接到椒图网关（全部挂 `JIAOTU_GATEWAY_URL`/`JIAOTU_API_KEY` env 开关，未设=现状逐字节不变）。四件：①`llm-client.ts` 条件鉴权头——构造时读 `JIAOTU_API_KEY`，存在则 chat() 附 `authorization: Bearer`，`llmSmokeProbe` 对椒图 404 的理由文案更新；②新增 `services/agent/src/jiaotu/token-ports-jiaotu.ts` 三 adapter：`JiaoTuMintClient`（POST `/internal/tickets/mint`，body 映射 `sub→agent_identity`/`caseId??""→case_id`，响应 `{token,jti,exp}` 合成 `payload:{jti,exp}`；`mintApprovalToken` 外部模式直接抛 `"approval mint belongs to gateway g4"`——INV-2 单口防误用）、`JiaoTuUsedTokenReader`（GET `/internal/tickets/:jti/burned`→`body.burned`；非 200 抛，INV-1 fail-closed）、`JiaoTuTokenBurner`（POST `/internal/tickets/:jti/burn`，Bearer api_key，fire-and-forget 2s 超时+结构化日志）；③`index.ts` 装配：`JIAOTU_GATEWAY_URL` 设定时四件 seam 换注入；④`scripts/jiaotu-register.ts` 一次性布景（对椒图注册 agent、api_key 写 .env，幂等按名查重）。adapter 契约测试注入 fetchImpl 捕获请求形态（路径/头/body 逐字段断言）+401/409/不可达 fail-closed 分支，不真出网（票 08 test_proxy.py 先例）。

**Touches modules:** `m9`

**Belongs to spec:** specs/modules.md（m9 安全控制面卡）；设计源：椒图仓 `docs/research/2026-09-10-狗粮全量接入设计.md` §3-G1/G3/G4、§4.1、§5

**Blocked by:** 无（椒图票 13 g2 上游授权注入、票 14 g4 case_id 透传均已 done，前置就绪）

**Status:** ready

**验收（每条注源）：**
- [ ] `JIAOTU_API_KEY` 设定时 chat() 头带 `authorization: Bearer`；未设时请求逐字节等于现状（源 §3-G1）
- [ ] mint adapter 请求形态逐字段断言（agent_identity/scope/case_id/run_id/allowed_tools/jti），响应合成 payload 满足消费方只用 `.token` 与 `.payload.jti`（源 §4.1 token-ports-jiaotu 行）
- [ ] `mintApprovalToken` 外部模式抛错且信息点名 g4（INV-2 单口，防误用）（源 §3-G5/§4.1）
- [ ] usedReader 非 200 抛错 fail-closed；burner fire-and-forget、2s 超时失败结构化日志（源 §3-G4/§4.1）
- [ ] 未设 `JIAOTU_GATEWAY_URL`：buildApp 注入路径与现状一致，agent 全量测试绿只增不减、evals 全绿（rigs 不设 env）（源 §5-1 零回归）
- [ ] 错误映射：429→rate_limited 等既有降级 reason 在内部模式不变；外部模式上游 429 经椒图 502 的 reason 漂移已核实无字面断言依赖（源 §3-G12）

**实现记录：**（待填）
