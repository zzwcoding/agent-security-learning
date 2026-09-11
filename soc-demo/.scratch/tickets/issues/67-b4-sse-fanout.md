# 67-b4-sse-fanout: B4 SSE 扇出（P2）

**What to build:** `scripts/bench/b4-sse.mjs`——1 个高事件率 run × N 订阅者（50/100/200 档，SSE 客户端自实现 fetch-stream，带 Last-Event-ID 重连语义）；观测：①订阅者滞后（首帧延迟/补发长度）②agent 容器 CPU（docker stats 采样入表）。对照组：同 N 的 1s 轮询客户端（取餐铃 vs 轮询的真实数字）。结果进报告 B4 节+结论。

**铁律:** 同票 64。

**Touches modules:** `m13`、`m3`

**Belongs to spec:** specs/modules.md（m13 卡）；设计源 docs/research/2026-09-12-压力测试方案.md §二#4/§三 B4

**Blocked by:** 66

**Status:** ready

**验收：**
- [ ] 脚本一键复现；50/100/200 三档表齐全（含轮询对照列）
- [ ] 结论写进报告（每订阅者 100ms 定时器的实测代价）
- [ ] services/** 零改动；全量测试保持绿

**实现记录：**（待填）
