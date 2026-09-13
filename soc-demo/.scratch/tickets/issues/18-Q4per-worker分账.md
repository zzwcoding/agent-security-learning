# 18-Q4per-worker分账: 注册粒度单 agent → 每 worker 一 agent(狗粮遗留 Q4/M2#9)

**What to build:** 兑现狗粮裁决 Q4 的 M2 后置项(设计 §六"分账留 M2"):soc-demo 侧 `scripts/jiaotu-register.ts` 从单 agent 扩展为按 worker 注册——triage/investigation/knowledge/chat 各一 agent(命名 `soc-demo-<worker>`),各得 api_key 写 `.env`(`JIAOTU_API_KEY_<WORKER>`,幂等按名查重沿用);`services/agent/src/index.ts` 装配按 worker 选 key(env 缺省回落单键 `JIAOTU_API_KEY`,单键模式逐字节回归)。收益:椒图 `llm_call` 审计的 actor(api_key 解析)自然按 worker 分列,"谁在调模型"从服务级细到 worker 级;soc-demo 内部 actor 归因(M2 审计)与椒图 actor 从此可交叉验证。**跨仓票**:改动几乎全在 soc-demo(scripts+装配+契约测试),椒图侧零代码或仅注册口径注记(specs/identity.md)。

**Touches modules:** `g1`(注记)+soc-demo m9 侧

**Belongs to spec:** specs/identity.md(注册口径注记);soc-demo specs/modules.md m9 备注

**Blocked by:** 无

**Status:** ready

**验收:**
- [ ] 四 worker 各一 agent 注册幂等(重跑不吐新 key);单键模式(env 未设分账键)回归逐字节不变(源:设计 §六 Q4 附注)
- [ ] 分账模式下 llm_call 审计 actor 按 worker 分列(伪上游或活体二选一,活体优先)(源:Q4 裁决动机)
- [ ] 两仓测试零回归;soc-demo 契约测试覆盖多键装配

**实现记录(2026-09-13 子 agent 施工;Status 留主窗口验收时动):**

- 落位与票面出入:worker 的 real LLM 构造点不在票面所写 `workers/*/llm.ts`(那是 fake 桩与 Real 壳),真构造点在 `src/run-kinds.ts` 四处 `new GatewayLlmClient({actor:"agent:<worker>"})`。本票收敛为装配唯一口 `workerLlmClient(worker, requestId)`(run-kinds.ts export;actor 与分账 worker 名一处声明,四处图工厂改调它,requestId 恒 `launch_<runId>` 口径原样)。index.ts 的四件 seam(mint/焚毁读/焚毁写/审批)按票面指示**未动**,维持服务级单键。
- 分账键流转(运行时面):`GatewayLlmClientOpts.worker?`(src/llm-client.ts)→ 构造 env 链 `opts.apiKey → JIAOTU_API_KEY_<WORKER大写> → JIAOTU_API_KEY`(`jiaotuWorkerEnvKey()` 推导,`JIAOTU_WORKERS` 名单同文件出口)。分账键未设 = 取值与改前完全同一路径,单键模式逐字节回归(头集合深等测试证明)。声明面只有四 worker;hunt 编排循环(makeLoopLlm)与 evals judge 不声明 → 维持单键/内部形态,有测试锁定「未声明 worker 的构造点不读分账键」。
- 分账键流转(注册面):`scripts/jiaotu-register.ts` 加 `--workers` 模式(`registerJiaotuWorkers()`:四 worker 各按名注册 `soc-demo-<worker>`,先查后建幂等沿用;created 者逐 worker **立即** upsert `.env` 的 `JIAOTU_API_KEY_<WORKER>`,中途网故障不丢已到手明文;已存在者跳过且不碰其 env 键;服务级 `JIAOTU_API_KEY` 绝不被分账注册触碰)。单 agent 注册路径零改动(票 62 八例原样回归)。脚本保持独立不 import services(边界闸 R4 口径),名单/键名与 llm-client 的一致性由 jiaotu-register.test.ts 跨面契约锁咬合(改一边不改另一边必红)。
- mint 不分账的裁定(票面要求研究后回报):四件 seam 维持服务级单键。理由:Q4 只裁 LLM 出站面粒度;mint 票面 `agent_identity`(sub=agent:<worker>)已在椒图铸票审计留 worker 归属,拆 key 不增添信息反而改变「服务级主体铸票」的既有承诺;按 worker 拆 mint 要动铸票调用链与 index.ts 装配,超出本票且无裁决背书。
- 测试(+12,agent 717 passed+3 skipped → 729+3;基线口径「52 文件/559」已过时,现为 69 文件):jiaotu-register.test 8→13(--workers 四 agent 名单与 q 过滤、env 四键落盘且不触单键、重跑幂等 .env 逐字节不变、部分已注册跳过不碰已存键、跨面契约锁);run-kinds.test 8→11(workerLlmClient 四 worker 各吃各 key + actor/requestId 口径、缺省回落单键、run-kinds 源内 `new GatewayLlmClient(` 恰 1 处的构造点唯一锁);llm-client.test +4(四 worker Bearer 各自 key、缺省回落、单键模式头集合逐字节深等、opts.apiKey 最高优先 + 未声明 worker 不读分账键)。
- 门禁:soc-demo `pnpm lint`/`typecheck`/`test` 全绿(六 workspace 全过);`check:boundary` PASS;`check:zero-increment` PASS。jiaotu 侧零代码改动(仅 specs/identity.md 注册口径注记):`check:specs` PASS、lint/typecheck 绿、25 文件 187 tests 全绿。
- 偏离记录:曾给 orchestration/llm-stubs.ts makeLoopLlm 加单键注记,`check:zero-increment` T20 抓机制层触碰(哪怕注释)→ 已回滚;hunt 单键裁定改记于 run-kinds.ts 注释 + llm-client.ts JIAOTU_WORKERS docstring + 行为测试三处。文档落点:`.env.example` 分账四键注释块、`specs/modules.md` m9 备注(Belongs to spec 所指)、椒图 `specs/identity.md` 注记。
- 活体留证(主窗口下次真网冒烟核验):`pnpm jiaotu:register --workers` 后 .env 四键就位 → 打真网流量(alert_flow/knowledge_flow/chat 各一枪)→ 椒图审计 llm_call 的 actor 应按 soc-demo-triage/investigation/knowledge/chat 分列(api_key 解析,非自报);再把 .env 分账四键撤掉单键模式重跑,actor 应回到服务级 soc-demo 单列——两态对照即验收②的活体证据。
