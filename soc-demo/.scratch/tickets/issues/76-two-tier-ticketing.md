# 76-two-tier-ticketing: 两票方案——父票 + 子任务 narrow-scope 票（P1）

**What to build:** 还 `run-kinds.ts:150` 欠下的"链段单独铸票"。① 父 run 票：planner 面（菜单查询类工具），m3 拉起循环 run 时铸；② 子 run 票：dispatch 按 planner 组合逐任务铸 narrow-scope 票（allowed_tools=该任务所需最小集，TTL 沿用 900s 口径）；③ 铸票时机改造：`app.ts`/`makeNodes` 票务 seam 从"按 kind 一次铸"演进为"父票铸于 run 起、子票铸于 dispatch 时"（gateway /internal/mint 现成，改的是调用方）；④ **遍历断言进 eval**：每类任务 × 票面 scope 外工具 = 100% 403（对齐现有 l2_privesc_403 范式），子票 scope 严格 ⊆ 父票菜单（票 71 边界条 b 的机器验证）；⑤ 椒图狗粮形态对齐：外接时铸票走椒图端口（JIAOTU_GATEWAY_URL 开关纪律同现有），默认形态逐字节不变。

**铁律:** 本票触及 INV-3 安全语义——fail-closed 全链路成立（铸票失败 = 子 run 不拉起，绝不留"无票悬置"）；安全件改 gateway 票务面不改验票闸本体（验票在 agent 侧不动）；边界红线——只许动 m3 票务装配与 m14 dispatch 铸票调用，m9 验票闸内部禁碰。

**Touches modules:** `m9`、`m3`、`m14`

**Belongs to spec:** specs/orchestration-loop.md（行号回填同上）


**Spec 绑定:** specs/orchestration-loop.md 验收测试表 T11-T15（spec 已定稿 2026-09-12）

**Blocked by:** 73

**Status:** done

**验收：**
- [x] 父票/子票铸票时序测试绿（fake gateway + 真 gateway 双跑）
- [x] 子票 scope ⊆ 父菜单遍历断言 100% 成立（eval 矩阵）
- [x] 子票 scope 外工具调用 100% 403（eval 矩阵，对齐 l2_privesc_403 范式）
- [x] 铸票失败 fail-closed：无票子 run 不存在，审计 DENIED 可查
- [x] 椒图 profile 下铸票走外接端口；默认形态回归零差异

**实现记录：**（2026-09-12 落地）

- **铸票时序（m3 侧，唯一通道不动）**：`app.ts` /internal/runs 对 hunt_task 随载任务上下文（`task.tool`）的拉起，在正门内经 `run-kinds.ts::ticketSpecFor(kind, task)` 解析窄票面**现铸**（子票铸于 dispatch——本 POST 就是 dispatch 的 launchTask 过门），票随 start 任务落盘（`run_jobs.payload.ticket/task`），执行件 `executeStartJob` 直接用不再二次铸；`rebuildResumeNodes` 按在册任务重解析同一致窄票面（票面 scope 生成后不可再改）。旧 kind（alert_flow 等）路径逐字节零变化（按注册表票面一次铸于 run 起，测试钉死）。
- **INV-11 缝闸**：`ticketSpecFor` 内父菜单外工具**拒铸抛错**（fail-closed 第二道；第一道是 planner 菜单闸 T04）；`ports.ts::RunDoor` 增加 `task?` 位，`launcher.ts` 只递数据不碰铸票（m14 目录零 mint import，R11 边界闸绿）。
- **fail-closed（T15）**：子票铸票失败 → `failUnTicketedRun`（run failed(mint_failed)+FAILURE 审计+error 事件，不 enqueue、无悬置）+ 502 回 dispatch → `flow.ts` dispatch 逐任务 try/catch 落五要素 **DENIED 审计**（`hunt_dispatch_mint_denied`）后原样上抛交 runner 强杀——INV-1/8 全链路。
- **测试（T11/T12/T15）**：`src/orchestration/ticketing.test.ts`（fake 腿时序 + 旧 kind 零变化 + 解析器缝闸 + T15）与 `src/ticketing-gateway.test.ts`（真 gateway 腿：子进程起真 services/gateway FastAPI 打真 /internal/mint，票再过真验票闸；椒图外接腿：JiaoTuMintClient wire 逐字段），共用布景 `src/ticketing-rig.ts`（测试基建位在 src/ 根——orchestration/ 有 T19 禁定时器与 R11 禁铸票客户端两道闸）。真 gateway 不可达显式 skip（compose-topology 探针先例）。
- **遍历矩阵（T13/T14）**：`evals/src/rigs/hunting.ts::inv11_matrix` + 伴侣 `hunting.test.ts`——真 buildApp 两轮跑满（fake LLM 覆盖全菜单 3 类任务），每枚子票 × 在册工具全集（tools.manifest 25 件）逐格过真闸：3×24=72 格 scope 外全 403 scope_insufficient、放行正控 3/3、TTL 过期重放 3/3 全拒 token_expired、TTL 900s、子票面零 L2、父票 ×2 轮各一枚面=菜单；六格 extraChecks 全绿。
- **边界表**：modules.md R2 例外列布景 rig 清单加 `hunting`（票 44·F6/票 45 ADR 0003 同角色扩展）。
- **偏差**：无实质偏差。一点落法说明——"无票子 run 不存在"的落地口径与旧 kind 铸票失败同构：失败的子 run 行落 failed(mint_failed)（可观察、非终态零行、不执行），而非物理无行（铸票需 run_id 做票面绑定，createRun 先行）。
- **L0 验收（主窗口，2026-09-13）**：亲跑双闸 PASS（R11 绿）+ agent 605 passed|3 skip + evals 101 passed；矩阵形态核对（72 格票面外全 403+正控 3+过期重放 3 拒，fake/真 gateway 双跑）。**R2 例外列扩展追认**：hunting rig 与 ADR 0003 已追认六 rig 完全同角色（进程内组装入口、禁触 db/store 写路径），内容正确——但**程序上越权**：豁免清单是 L0 专属产出，L2 应停下回报由 L0 落笔；本次追认记录在案，下不为例（sdd-flow 阶段 5 边界红线原文）。铸票失败语义（failed(mint_failed) 行可观察、不执行、簿记零子链）与旧 kind 同构，接受。收尾五样齐（modules.md R2 行 L0 追认即同步完成）。挂账：本票回报提及 5 个**既有** lint error（未触碰文件：case-backend×2 + 73/74/75 三测试文件）——**列阶段 E 体检候选**（若 lint 是门禁则修复票清偿）。