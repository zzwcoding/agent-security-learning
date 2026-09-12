# 76-two-tier-ticketing: 两票方案——父票 + 子任务 narrow-scope 票（P1）

**What to build:** 还 `run-kinds.ts:150` 欠下的"链段单独铸票"。① 父 run 票：planner 面（菜单查询类工具），m3 拉起循环 run 时铸；② 子 run 票：dispatch 按 planner 组合逐任务铸 narrow-scope 票（allowed_tools=该任务所需最小集，TTL 沿用 900s 口径）；③ 铸票时机改造：`app.ts`/`makeNodes` 票务 seam 从"按 kind 一次铸"演进为"父票铸于 run 起、子票铸于 dispatch 时"（gateway /internal/mint 现成，改的是调用方）；④ **遍历断言进 eval**：每类任务 × 票面 scope 外工具 = 100% 403（对齐现有 l2_privesc_403 范式），子票 scope 严格 ⊆ 父票菜单（票 71 边界条 b 的机器验证）；⑤ 椒图狗粮形态对齐：外接时铸票走椒图端口（JIAOTU_GATEWAY_URL 开关纪律同现有），默认形态逐字节不变。

**铁律:** 本票触及 INV-3 安全语义——fail-closed 全链路成立（铸票失败 = 子 run 不拉起，绝不留"无票悬置"）；安全件改 gateway 票务面不改验票闸本体（验票在 agent 侧不动）；边界红线——只许动 m3 票务装配与 m14 dispatch 铸票调用，m9 验票闸内部禁碰。

**Touches modules:** `m9`、`m3`、`m14`

**Belongs to spec:** specs/orchestration-loop.md（行号回填同上）


**Spec 绑定:** specs/orchestration-loop.md 验收测试表 T11-T15（spec 已定稿 2026-09-12）

**Blocked by:** 73

**Status:** blocked

**验收：**
- [ ] 父票/子票铸票时序测试绿（fake gateway + 真 gateway 双跑）
- [ ] 子票 scope ⊆ 父菜单遍历断言 100% 成立（eval 矩阵）
- [ ] 子票 scope 外工具调用 100% 403（eval 矩阵，对齐 l2_privesc_403 范式）
- [ ] 铸票失败 fail-closed：无票子 run 不存在，审计 DENIED 可查
- [ ] 椒图 profile 下铸票走外接端口；默认形态回归零差异

**实现记录：**（待填）
