# 27: 真 LLM adapter 接线——四 worker 经 gateway 代理出站（回补票）

**What to build:** triage/investigation（及提炼、后续 worker 复用同机制）的 FakeXxxLlm 旁挂生产 adapter：真 LLM 调用经 services/gateway `/proxy/llm/*` 出站（占位符换真凭证 + 金丝雀断言，票 08 契约），模型经 env 可配（minimax-m2 或可用模型）。**LLM seam 接口与 prompt 契约（事实接口）不变**，fake ↔ real 可切换；契约测试用固定响应形态的 mock 上游保确定性，真网冒烟走能力探测（有真 key 才跑）。

**Blocked by:** 08

**Touches modules:** `m3`, `m4`, `m5`

**Belongs to spec:** specs/modules.md

**Status:** ready-for-agent

- [ ] 生产 LLM adapter 经 gateway /proxy/llm/* 出站：占位符 `${{ SECRETS.* }}` 在代理层换真值，金丝雀不出现在任何可观测面（源：PRD S1·INV-4·票 08 契约）
- [ ] worker 的 LLM 注入点支持 fake ↔ real 切换（env/配置），compose 默认 real、测试默认 fake（源：m3/m4/m5 卡 LLM seam·ADR 0002）
- [ ] mock 上游契约测试：出站请求形态符合 prompt 契约；响应经 schema 把关（parseVerdict/parseReport），不合 schema 的重试/降级路径与 Fake 版一致（源：票 13/14 schema 契约保持）
- [ ] 超时/限流/上游不可达 → fail-closed（worker 降级路径与 budget 三闸语义保持，不裸抛）（源：INV-1·票 10）
- [ ] 真网冒烟：能力探测（SECRETS_LLM_API_KEY 有真值才跑并打印证据；无 key 显式 skip 留痕），至少一条真实告警产出 verdict 且结构合法（源：ADR 0002 决策 2）
- [ ] 架构投影文档与最终形态一致（源：收尾第⑤样）
