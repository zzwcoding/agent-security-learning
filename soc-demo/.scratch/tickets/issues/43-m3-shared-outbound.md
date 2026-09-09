# 43-m3-shared-outbound: 安全件与重复收敛（F1+F3+F5+F4+F7）

**What to build:** ① gated() 验票包装六处收敛为共享 makeGatedCall（安全语义集中一处，F1）；② guards/llm/fga 三客户端抽共享 outbound 件（超时+错误分类+ProbeResult，F3，顺带修 reason 标签口径漂移）；③ ChatSeam 上提 llm-client、token-ports 抽 postMint、McpTool 收敛（F5）；④ openfga 钉 digest、msb 版本记录（F4）；⑤ tsx 挪 devDep、web/dist 入 gitignore（F7）。行为零变化，测试全绿。

**Blocked by:** 33, 35

**Touches modules:** `m3`, `m4`, `m8`, `m9`, `m12`

**Belongs to spec:** specs/modules.md

**Status:** ready-for-agent

- [ ] gated() 单处定义（源：结构-6）
- [ ] 共享 outbound 件且 reason 口径统一（源：结构-8）
- [ ] 微重复收敛 + 依赖卫生（源：结构-9/11/12·对账一-2/3/7）
- [ ] 全仓测试零删除零放松（源：体检口径）
