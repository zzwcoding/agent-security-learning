# 27: 真 LLM adapter 接线——四 worker 经 gateway 代理出站（回补票）

**What to build:** triage/investigation（及提炼、后续 worker 复用同机制）的 FakeXxxLlm 旁挂生产 adapter：真 LLM 调用经 services/gateway `/proxy/llm/*` 出站（占位符换真凭证 + 金丝雀断言，票 08 契约），模型经 env 可配（minimax-m2 或可用模型）。**LLM seam 接口与 prompt 契约（事实接口）不变**，fake ↔ real 可切换；契约测试用固定响应形态的 mock 上游保确定性，真网冒烟走能力探测（有真 key 才跑）。

**Blocked by:** 08

**Touches modules:** `m3`, `m4`, `m5`

**Belongs to spec:** specs/modules.md

**Status:** done

### 执行记录（2026-09-08，编码窗口）

1. **载体形态**：`src/llm-client.ts`（GatewayLlmClient，guards-client 同族的共享出站件）+ `workers/triage/llm-real.ts`（RealTriageLlm）+ `workers/investigation/llm-real.ts`（RealInvestigationLlm）。出站 = POST `{SOC_LLM_PROXY_URL}/v1/chat/completions`（默认 `http://gateway:8002/proxy/llm`，compose 服务名），OpenAI 兼容 chat/completions 形态（m3/m4 卡口径；minimax 兼容该形态——见出入③），prompt 契约文本逐字作为唯一 user 消息出域（不拆不改），`temperature:0`，`x-actor-id`/`x-request-id` 头与代理审计五要素关联（票 08）。模型 env `LLM_MODEL`（默认 minimax-m2，PRD 决策 #7）。
2. **fake ↔ real 切换（验收②）**：seam 接口（TriageLlm/InvestigationLlm）与 prompt 契约一字未动，flow.ts/graph.ts 零改动——只换 `deps.llm` 注入物。index.ts 生产装配按 `AGENT_LLM` env 选（**缺省 real**，ADR 0002 红线；`AGENT_LLM=fake` 留给本机离线开发；vitest 各 rig 显式注入 Fake，不经开关——测试默认 fake 天然成立）；compose agent 挂 `AGENT_LLM: real` + `LLM_MODEL` + `SOC_LLM_PROXY_URL`（全可覆盖）并补 depends_on gateway。m4/m5 卡 Seam 本就写明双 adapter（"minimax-m2 经凭证代理 / eval fixture 伪 LLM"），本票补齐 real 半边。
3. **fail-closed 分流（验收④）**：adapter 的 HTTP 超时与 budget 三闸同 env 链（`LLM_TIMEOUT_MS_<NODE>` > `LLM_TIMEOUT_MS` > 60s，决策 #4）——adapter 先断，`ctx.checkLlm` 墙钟仍是最终兜底闸，对齐不抢闸。错误一律映射成类型化 `LlmUpstreamError`（timeout/unreachable/rate_limited/http_50x/bad_shape），**上游/代理的错误正文不进 error 消息**（provider 可控文本不许流入审计/SSE 面）。按方法分流：有 worker 降级路径的（triage verdict / investigation report）→ 不裸抛，回必然不合 schema 的标记回包（`{"verdict":"llm_upstream_<code>"}` / `llm_upstream:<code>`），让既有「重试 1 次 → uncertain+human / 降级自由文本+标记」原样接管（与 Fake 版一致，reason code 落进 rationale 与降级 timeline body）；无降级路径的（plan/decide/summarize）→ 抛类型化错误由 runner 强杀（failed + 审计 + error 事件），绝不硬编造任务清单/finish/摘要。
4. **mock 上游契约测试（验收③）**：TS 侧等价 seam = 注入 `fetchImpl`（票 08 test_proxy.py 的 httpx.MockTransport 先例），新增 24 测试：src/llm-client.test.ts（出站请求形态 11 条：URL/方法/头/体定形、env 覆盖、INV-4 agent 侧金丝雀、响应解析、错误映射、超时 env 链、围栏剥壳）+ triage/llm-real.test.ts（4 条：含全链路布景——真 case-backend + mock 上游 503 ×重试 1 次 → run completed + uncertain + human + llm_retry 审计，出站 URL 逐请求断言 /proxy/llm/v1/chat/completions）+ investigation/llm-real.test.ts（9 条：脚本化 mock 上游驱动完整 plan→tool_loop→report→write_timeline、report 429 降级进 Timeline + report_degraded 审计、plan 阶段病 → failed 强杀）。真模型 markdown 围栏由 `unwrapJsonText` 无损剥壳，schema 把关仍在 worker（parseVerdict/parseReport），不硬修到合法。
5. **真网冒烟（验收⑤，真跑）**：`llmSmokeProbe` 能力探测（SECRETS_LLM_API_KEY 有真值 + gateway /proxy/llm 可达才跑；否则 describe.skipIf 显式 skip 并打印原因，票 16 msbProbe 先例）。本机 Keychain 有 minimax 真 key（`agent-key minimax` 取用，不落盘不入库），`SECRETS_LLM_API_KEY=$(agent-key minimax) docker compose up gateway` + `LLM_TIMEOUT_MS=120000 pnpm vitest run src/llm-client.test.ts` **真网全通**：5712 真实告警经 gateway /proxy/llm/* 出站（代理审计 `proxy.forward actor=agent:triage request_id=smoke-ticket-27 POST /v1/chat/completions upstream=200 took=4.99s`），minimax-m2 判 `verdict=tp confidence=0.85 action=create_case`（与人工标注一致），parseVerdict 结构合法，tokens=913；真 key 在网关日志 grep 0 命中（金丝雀纪律实证）。真网实测两处发现：① MiniMax-M2 的 content 自带 `<think>…</think>` 推理前缀 → `unwrapJsonText` 增加无损剥离（未闭合不误吞）；② 上游端点对模型 id 大小写不敏感（`minimax-m2` 即可），compose 默认 LLM_MODEL 无需改。
6. **投影同步（验收⑥）**：arch-notes.json 三卡（m4-triage/m5-investigation/llm-provider）补真 adapter 事实，`node scripts/inject-arch-notes.mjs` 重注入 10 张 html；m4/m5 结构图本体无出入（图中 "LLM 调用走代理" 本就画的是目标形态，"eval 用伪 LLM fixture" 表述仍真）。教学文档 lessons/27-01。
7. **边界确认**：enrichment worker 无 LLM 决策点（票 15，三节点确定性子图）本票未动；knowledge worker 未建（票 17），届时复用同一 llm-client。既有 216 agent 测试一条未删未放松（全绿）。冒烟后带真 key 的 gateway 容器已 stop（真 key 不留运行态）。

### 出入记录（本票发现，记票不改 spec，交 L0 对账）

1. **modules.md m4/m5 卡「Adapter: fixture 伪 LLM」行与本票后的默认装配不一致**：卡 Seam 行已写明双 adapter，但 "Adapter:" 行只列 fixture 伪 LLM；票 27 后 compose 默认 real（AGENT_LLM=real）。不改 spec 本体，待 L0 对账改卡。
2. **调查 worker（m5）尚无生产拉起路径**：app.ts `RUN_KINDS` 只放行 alert_flow（票 14 起即如此，非本票引入），RealInvestigationLlm 已建成并全链路测试覆盖，case_flow 生产放行在后续票接——m5 卡「子图输入 {case_id, ticket}」的公开接口不变。
3. **上游 API 形态口径**：m3/m4 卡只说 "minimax-m2 经凭证代理"，未写 wire 形态；按 OpenAI 兼容 chat/completions 实现（PRD 决策 #7 的模型名 + compose SOC_LLM_UPSTREAM=api.minimaxi.com 口径自洽），mock 上游契约测试锁形态；真网冒烟实测若 minimax 端点有出入（如鉴权头差异），在代理层适配、不动 agent 侧契约。
4. **无 key 时的 compose 形态**：按票面 "real adapter + 教学 key + 能力探测 skip" 口径——compose 仍默认 real（SECRETS_LLM_API_KEY 教学留空 = 网关 503 fail-closed → worker 降级 uncertain+人工，链路可观察不崩）；要真出站由部署环境注入真 key。

- [x] 生产 LLM adapter 经 gateway /proxy/llm/* 出站：占位符 `${{ SECRETS.* }}` 在代理层换真值，金丝雀不出现在任何可观测面（源：PRD S1·INV-4·票 08 契约）
- [x] worker 的 LLM 注入点支持 fake ↔ real 切换（env/配置），compose 默认 real、测试默认 fake（源：m3/m4/m5 卡 LLM seam·ADR 0002）
- [x] mock 上游契约测试：出站请求形态符合 prompt 契约；响应经 schema 把关（parseVerdict/parseReport），不合 schema 的重试/降级路径与 Fake 版一致（源：票 13/14 schema 契约保持）
- [x] 超时/限流/上游不可达 → fail-closed（worker 降级路径与 budget 三闸语义保持，不裸抛）（源：INV-1·票 10）
- [x] 真网冒烟：能力探测（SECRETS_LLM_API_KEY 有真值才跑并打印证据；无 key 显式 skip 留痕），至少一条真实告警产出 verdict 且结构合法（源：ADR 0002 决策 2）——本机 Keychain 取 minimax 真 key 真跑全通：5712 告警经代理出站 verdict=tp（与标注一致）parseVerdict 合法，代理审计留痕、真 key 日志 0 命中；无 key 环境（CI）自动 skip 并打印原因
- [x] 架构投影文档与最终形态一致（源：收尾第⑤样）
