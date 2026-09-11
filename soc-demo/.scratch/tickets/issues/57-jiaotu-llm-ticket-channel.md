# 57-jiaotu-llm-ticket-channel: 狗粮票 A · LLM+票务通道改走椒图（m9 外部化第一拍）

**What to build:** 默认形态零变化的前提下，把 soc-demo 的 LLM 出站与票据申领/焚毁接到椒图网关（全部挂 `JIAOTU_GATEWAY_URL`/`JIAOTU_API_KEY` env 开关，未设=现状逐字节不变）。四件：①`llm-client.ts` 条件鉴权头——构造时读 `JIAOTU_API_KEY`，存在则 chat() 附 `authorization: Bearer`，`llmSmokeProbe` 对椒图 404 的理由文案更新；②新增 `services/agent/src/jiaotu/token-ports-jiaotu.ts` 三 adapter：`JiaoTuMintClient`（POST `/internal/tickets/mint`，body 映射 `sub→agent_identity`/`caseId??""→case_id`，响应 `{token,jti,exp}` 合成 `payload:{jti,exp}`；`mintApprovalToken` 外部模式直接抛 `"approval mint belongs to gateway g4"`——INV-2 单口防误用）、`JiaoTuUsedTokenReader`（GET `/internal/tickets/:jti/burned`→`body.burned`；非 200 抛，INV-1 fail-closed）、`JiaoTuTokenBurner`（POST `/internal/tickets/:jti/burn`，Bearer api_key，fire-and-forget 2s 超时+结构化日志）；③`index.ts` 装配：`JIAOTU_GATEWAY_URL` 设定时四件 seam 换注入；④`scripts/jiaotu-register.ts` 一次性布景（对椒图注册 agent、api_key 写 .env，幂等按名查重）。adapter 契约测试注入 fetchImpl 捕获请求形态（路径/头/body 逐字段断言）+401/409/不可达 fail-closed 分支，不真出网（票 08 test_proxy.py 先例）。

**Touches modules:** `m9`

**Belongs to spec:** specs/modules.md（m9 安全控制面卡）；设计源：椒图仓 `docs/research/2026-09-10-狗粮全量接入设计.md` §3-G1/G3/G4、§4.1、§5

**Blocked by:** 无（椒图票 13 g2 上游授权注入、票 14 g4 case_id 透传均已 done，前置就绪）

**Status:** done（2026-09-11 主窗口验收：五门禁 worktree 复跑全绿，agent 493→510+4s 只增不减，evals 33/33 triage_accuracy=1.000，椒图仓 177 全绿零影响）

**验收（每条注源）：**
- [x] `JIAOTU_API_KEY` 设定时 chat() 头带 `authorization: Bearer`；未设时请求逐字节等于现状（源 §3-G1）
- [x] mint adapter 请求形态逐字段断言（agent_identity/scope/case_id/run_id/allowed_tools/jti），响应合成 payload 满足消费方只用 `.token` 与 `.payload.jti`（源 §4.1 token-ports-jiaotu 行）
- [x] `mintApprovalToken` 外部模式抛错且信息点名 g4（INV-2 单口，防误用）（源 §3-G5/§4.1）
- [x] usedReader 非 200 抛错 fail-closed；burner fire-and-forget、2s 超时失败结构化日志（源 §3-G4/§4.1）
- [x] 未设 `JIAOTU_GATEWAY_URL`：buildApp 注入路径与现状一致，agent 全量测试绿只增不减、evals 全绿（rigs 不设 env）（源 §5-1 零回归）
- [x] 错误映射：429→rate_limited 等既有降级 reason 在内部模式不变；外部模式上游 429 经椒图 502 的 reason 漂移已核实无字面断言依赖（源 §3-G12）

**实现记录：**（2026-09-11 施工完毕，待主窗口验收）

**改动文件**（未 commit，留主窗口验收提交）：
- 修改 `services/agent/src/llm-client.ts`（+18/-2）：构造 opts 增 `apiKey?`（缺省 env `JIAOTU_API_KEY`）；chat() 头集合条件附 `authorization: Bearer <值>`（key 未设时一个 authorization 键都不落，请求与现状逐字节相同）；文件头补狗粮形态说明段；`llmSmokeProbe` 注释与不可达理由文案更新（椒图无 `/v1/models` 路由、404 也算"有回话即可达"，探针逻辑零改——不判状态码的口径内外两形态通吃）。
- 新增 `services/agent/src/jiaotu/token-ports-jiaotu.ts`（159 行）三 adapter：`JiaoTuMintClient`（POST `/internal/tickets/mint`，body `{agent_identity←sub, scope, case_id←caseId??"", run_id, allowed_tools, jti}`，201 `{token,jti,exp}` 合成 `{token, payload:{jti,exp}}`；`mintApprovalToken` async 抛 `"approval mint belongs to gateway g4"`）、`JiaoTuUsedTokenReader`（GET `/internal/tickets/:jti/burned`，仅 200 可信，非 200 一律抛——INV-1 fail-closed）、`JiaoTuTokenBurner`（POST `/internal/tickets/:jti/burn`，`authorization: Bearer <JIAOTU_API_KEY>`，无请求体，fire-and-forget + `AbortSignal.timeout(2000)`，网络错/超时/非 2xx 均落结构化日志 `warn=jiaotu_burn_failed`）。三件共用 opts 构造注入 baseUrl/apiKey/fetchImpl（GatewayLlmClient idiom），wire 契约注释标注椒图 identity/index.ts 行号真源。
- 修改 `services/agent/src/index.ts`（+21/-1）：`JIAOTU_GATEWAY_URL` 设定时 mint/usedReader/burn 三 seam 换 jiaotu adapter（baseUrl 显式传入）；未设 = 原装配逐字节不变（仍 `new HttpUsedTokenReader()`，mint/burn 走 buildApp 缺省）。审批 approvalGateway seam 属票 58，本票未加。
- 新增 `scripts/jiaotu-register.ts`（134 行）：一次性布景。先查后建幂等（`GET /api/v1/agents?q=<name>` 精确匹配 name，同椒图 seed-demo 口径；已核实椒图重名不冲突、api_key 无重置端点，丢了换 `--name` 重注册）；注册 body `{name, scope:["任务票申领","票据焚毁","LLM 出站"], owner}`（椒图注册身份 scope 是描述性元数据，执行鉴权吃票面 scope——已核实），201 `{agent_id, api_key}` → `JIAOTU_API_KEY` upsert 仓库根 `.env`（gitignored；新建/追加/整行替换三态），agent_id 打印 stdout；网络错大声抛错带上下文。根 `package.json` 增 `pnpm jiaotu:register` 脚本位（设计文档 §五 的调用口径）。
- 新增 `services/agent/src/jiaotu/token-ports-jiaotu.test.ts`（240 行，15 例）+ `llm-client.test.ts` 增补（+31 行，2 例）：fetchImpl 注入捕获请求，路径/头/body 逐字段断言，不真出网。

**验收行落地**：
1. 鉴权头：`llm-client.test.ts` 狗粮形态 describe——未设 key 深等整个头集合（无 authorization 键、URL 不变）；设 key（env 或构造注入）断言 `authorization: Bearer <值>` 且其余头不动。✅
2. mint 逐字段：`token-ports-jiaotu.test.ts` 断言 body 六键 `agent_identity/scope/case_id/run_id/allowed_tools/jti` 精确 toEqual + 2s AbortSignal 在位；响应合成断言 `.token`/`.payload.jti`/`.payload.exp`；caseId null → `case_id:""`。✅
3. `mintApprovalToken` 抛错信息逐字 `"approval mint belongs to gateway g4"`，且断言零字节出站（INV-2 单口）。✅
4. usedReader：401/404/409/502 逐个断言抛、网络不可达抛；burner：fire-and-forget 不抛、网络错与 401 两种失败均断言 `console.error` 结构化行（`warn=jiaotu_burn_failed` + jti + error，401 正文不进日志）。✅
5. 未设 `JIAOTU_GATEWAY_URL`：evals 全仓 rigs 零引用该 env（grep 核实），agent 全量测试绿只增不减（见下）；门禁全绿。✅
6. 错误映射（G12）：`llm-client.ts` 的 429→`rate_limited` 映射行未动（内部模式不变）；grep 全仓测试，`rate_limited` 字面断言仅三处来源——`llm-client.test.ts:147`（对 client 直喂 429 Response 的映射测试，不经过任何代理，两形态下都成立）、`workers/{triage,chat,investigation}/llm-real.test.ts`（直接构造 `LlmUpstreamError("rate_limited"` 测 worker 降级，不依赖 wire 状态码）。**没有任何测试断言"上游 429 经代理后仍报 rate_limited"**，故外部模式上游 429 经椒图 502 → reason 变 `http_502` 不破任何断言。核实结论：无字面断言依赖，接受漂移（§3-G12 处置）。

**测试数量**：`services/agent` 基线 48 文件 / 493 passed + 4 skipped（497）；完工 49 文件 / 510 passed + 4 skipped（514）。净增 1 文件 / 17 例，零删改（只增不减）。

**门禁**：`pnpm lint` ✅；`pnpm typecheck` ✅（7 包全 Done）；`pnpm test` ✅（全 workspace 绿：agent 49f/510+4s、web 7f/60、evals 8f/99、其余包全绿）；`pnpm test:eval` ✅（1 文件 / 34 例 + 场景报告 33 ran / 33 passed，triage_accuracy=1.000，各拦截率 100%）。

**偏离票面的决定**：① burn 请求体不发 `{jti, source}`——椒图焚毁口只认路径 jti + Bearer 头（identity/index.ts:817-847 已核实），接口形保留 source 参数但不进 wire；非 2xx（如 401）也补了结构化日志（票面只要求超时失败日志，401 是椒图形态的真实失败面，可见性照挂）。② `mintApprovalToken` 实现不收参（接口兼容，规避 unused-param lint），async 保证以 rejected promise 炸。③ 根 `package.json` 加了 `jiaotu:register` 脚本位（票面未点名该文件，设计文档 §五 以 `pnpm jiaotu:register` 为调用口径；compose/`.env.example` 未碰，属票 59）。
