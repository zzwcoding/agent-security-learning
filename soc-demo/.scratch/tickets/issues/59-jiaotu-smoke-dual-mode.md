# 59-jiaotu-smoke-dual-mode: 狗粮票 C · 六幕冒烟 + compose 双模式（全外接 profile，m3 部署面）

**What to build:** 狗粮验收载体。①compose 新增 profile `jiaotu`：`jiaotu-gateway` 服务（context `${JIAOTU_REPO_PATH:-../agentjiaotu}`，env：`HMAC_SIGNING_KEY=${SOC_HMAC_KEY}` 同源分发[G13]、`APPROVER_TOKEN`、`UPSTREAM_BASE_URL=${JIAOTU_LLM_UPSTREAM:-}`、`SECRETS_LLM_API_KEY`；GATEWAY_POLICY_DIR 沿椒图默认策略——幕 2 双开纵深[裁决 2026-09-11 Q3]）；**全外接形态：jiaotu profile 排除 soc-demo 内部 gateway 服务（不启动），默认九服务拓扑一字不动**；agent 服务 env 样例注释（`JIAOTU_GATEWAY_URL/JIAOTU_API_KEY`）；internal 两口不 publish 宿主（Q7 硬要求，施工核实）。②`compose-topology.test.ts` 补 profile 断言：jiaotu 栈含 jiaotu-gateway、**不含内部 gateway 服务**、HMAC env 同源。③`scripts/jiaotu-smoke-11.sh` 六幕逐幕 curl+断言（web-smoke-21.sh 狗粮姊妹篇；`--real-llm` 可选开关[Q8]）。④`.env.example` 增补 `JIAOTU_REPO_PATH/JIAOTU_API_KEY/JIAOTU_LLM_UPSTREAM`。⑤README 诚实边界：internal 两口跨项目 compose 网内无认证（Q7）。

**Touches modules:** `m3`（部署拓扑与冒烟载体）

**Belongs to spec:** specs/modules.md（m3 编排/部署面）；设计源：椒图仓设计文档 §二、§四 4.1、§五（四道全绿口径）

**Blocked by:** 58

**Status:** blocked（等 58）

**验收（四道全绿，每条注源）：**
- [ ] 零回归（内部模式）：`pnpm test`（含 approval-loop 五验收）+`pnpm test:eval` 全绿，rigs 不设 env（源 §5-1）
- [ ] adapter 契约：57/58 的 `jiaotu/*.test.ts` 全绿（源 §5-2）
- [ ] 六幕外部冒烟逐幕 PASS（源 §5-3）：幕1 `[J]` llm_call OK+mint_ticket OK+审批卡 pending 可查；幕2 双开两段（`[S]` guardsDenied≥1 + `[J]` plugin_block/llm_call DENIED）；幕3 `[S]` 403 强杀；幕4 `[J]` 时间线三连+重放 403 token_used+并发 409；幕5 kb_write 经 `[J]` 批准+毒提案 `[S]` 驳回；幕6 eval 数字与内部模式一致
- [ ] 椒图侧回归：椒图 `pnpm test`+`pnpm bench` 双门槛不受影响（源 §5-4）
- [ ] jiaotu 栈拓扑断言：含 jiaotu-gateway、不含内部 gateway 服务、HMAC env 同源（源 裁决 2026-09-11 全外接形态）
- [ ] Q7 硬要求落账：internal 两口未 publish 宿主核实记录 + README 诚实边界段落（源 裁决记录 Q7）
- [ ] `--real-llm` 真网冒烟（可选环节）：金丝雀 0 命中断言 + 票 13 UPSTREAM_AUTHORIZATION 实弹验证（源 裁决记录 Q8 附注）

**实现记录：**（待填）
