# 82-hunting-web-pages: Web 面——狩猎入口 + 轮次视图（P2）

**What to build:** 票 71 页面映射节的实现。① 狩猎入口页（或并入既有案件页入口，按票 70 逼问结论）：输入假设 + 选模板 → 拉起循环 run；② 轮次视图：round 卡片列（每轮的组合 C_k、N 个子 run 状态、judge 裁决、gap 缺口描述），SSE 实时推进（复用现有事件总线与 Last-Event-ID 补发，INV-7），断线刷新从 run 行 + 审计重建；③ 零特权原则照旧：全部走公开 REST+SSE，每屏配 curl 等价脚本（Web 与 curl 渠道平权，决策 #6 纪律）；④ 数据源 adapter 模式照旧（真后端/MSW 打桩）。

**铁律:** 前端不引状态管理库（已拍板）；路由快照锁死（新增页面必进快照测试）；SSE 断线重连语义与现有流水线页一致（INV-7 断言）；**禁为 Web 开后门接口**——页面要的数据必须是票 71 已落卡的公开接口，缺查询面 = 回阶段 2 补卡，不许前端自造数据源。

**Touches modules:** `m10`、`m14`（只读消费）、`m3`（SSE）

**Belongs to spec:** specs/modules.md 页面映射节（票 71 落卡行）


**Spec 绑定:** specs/orchestration-loop.md 验收测试表 PRD §13.7 + modules.md 页面映射节（非本 spec 验收表）（spec 已定稿 2026-09-12）

**Blocked by:** 73

**Status:** done

**验收：**
- [x] 狩猎入口到 run 拉全链路通（curl 等价脚本同绿）
- [x] 轮次视图实时推进 + 断线补发（INV-7 断言）
- [x] 路由快照更新（新增页面全登记）
- [x] MSW 打桩下前端单测绿；真后端冒烟过
- [x] 无 Web 专属接口（边界闸可查）

**实现记录：**（2026-09-13 落，自主档 TDD；Blocked by 73 已解除）

**产物**
- `services/web/src/routes.ts`：路由表增第七页 `hunting`（label 狩猎假设）——授权源=页面映射节（票 71 落卡六行）+ PRD §13.7「新增第七页：狩猎页」，既有六页不动；App 壳接线（`#/hunting?hypothesis_id=` 深链）。
- `services/web/src/pages/HuntingPage.tsx`（新）：①发起表单（假设句 + template_id）→ POST /api/v1/hypotheses（发起人走 x-actor-id 头，INV-8 取消比对锚）；②假设列表（五态 Tag + 仅 hunting 出取消按钮 → Popconfirm → POST :id/cancel，409/403 人话转述）；③轮次视图卡（每轮组合 C_k/子 run 状态/judge 裁决/gap 缺口/父 run 锚）；④收敛结论（concluded → 既有案件查询面按 cases.hypothesisId 反查建「查看命中案件」链接；refuted → 证伪摘要如实渲染）；⑤实时推进=复用 ./sse 事件总线（INV-7 Last-Event-ID/after 游标补发，retryMs 300 演示快退避）——SSE 只当信号帧，轮次账面以 m2 详情读面为准，账面帧（声明/回归/接力/终态/error）后自动重取；⑥断线重建=rebuildRoundViews（详情轮次归集段 + m2 审计 hunt_round_outcome 条目的 details.run_id/requestId hunt_<run_id> 父 run 锚），父 run 终态收流后审计锚变了自动接上下一轮 run 的流（多轮推进）。
- `services/web/src/hunting.ts`（新，纯函数层）：五态 Tag 档 / runAnchorOf / roundRunAnchors / rebuildRoundViews（含轮间接力在途占位卡，不猜数）/ applyHuntEvent 归约（**INV-7 恰一次归约侧断言**：ev.id ≤ 游标的重放帧是 no-op；账面帧标记 isLedgerFrame 供页面触发重取）。
- `services/web/src/api.ts`：假设 CRUD 客户端四件（listHypotheses/createHypothesis/cancelHypothesis/getHypothesisDetail，wire 归一照 case-backend mapHypothesis/mapRound）+ findCaseIdByHypothesis + CaseRow 补 `hypothesisId`（票 73/75 已落列，wire 既有字段）。
- `services/web/vite.config.ts`：代理表补 `/api/v1/hypotheses` → m2（分叉规则不破坏：该前缀此前无主；vite-proxy.test.ts 静态对账闸咬住）。
- 测试：`routes.test.ts`（快照七页红→绿）、`hunting.test.ts`（新，15 例：CRUD wire 归一/审计锚重建/轮间接力占位/INV-7 重放 no-op/五态档全集）、`pages.test.tsx`（HuntingPage 八例：五态列表+发起正门带发起人头/轮次卡装配/declared-joined-relay 帧落卡+同 id 重放恰一次/断线按游标重连 after=5/多轮终态接新流/取消 409 人话/concluded Case 链接/非 hunting 无取消按钮；App 壳菜单 6→7）。
- `scripts/hunt-smoke-82.sh`（新，curl 等价脚本）：五步对账（发起→列表+status 过滤→轮次归集段出现→审计父 run 锚+SSE 回放→终态对账含 hunting 窗口抢取消），全部走 :5173 同源代理公开面。

**验收证据（票面五条）**
- 全链路通：`WEB=http://127.0.0.1:5174 bash scripts/hunt-smoke-82.sh` → SMOKE PASS（真后端=compose case-backend/agent 重建后镜像 + 本地 vite 代理；POST 201 → autorun 拉起 hunt_flow → rounds=2 → concluded+建案挂 hypothesis_id；另一轮次跑出 hunting→POST cancel 200→cancelled，取消端点同绿）。
- 实时推进 + 断线补发：pages.test.tsx SSE 三例（declared/joined/relay 帧落卡；断线重连 URL `after=<最后事件 id>`；同 id 重放恰一次）+ hunting.test.ts INV-7 归约断言 + sse.test.ts 既有补发语义（同一封装，未动）。
- 路由快照：routes.test.ts 断言七页精确数组 + 闭合性 + 深链解析；App 壳菜单七项一字不差。
- 打桩单测 + 真后端冒烟：打桩形态照 m10 卡（真后端/vi.stubGlobal fetch stub 双形态，票 21/31 先例——**未引 MSW 库**，m10 卡 adapter 已拍板 fetch stub，不新增依赖）；真后端 SMOKE PASS 见上。
- 无 Web 专属接口：页面数据全部消费票 73 已落卡端点（m2 hypotheses CRUD/轮次归集/audit + m3 events/stream + 既有 cases 面）；check_boundary PASS（12/12，R6 web 纯展示壳零违例）。

**记入偏差（如实）**
1. **模板选择降级**：GET 模板清单的公开面不存在（票 79 模板登记面=agent 进程内 HuntTemplateSource，页面映射六行亦无此查询面；PRD §13.7 明言「新查询面仅两条」）——按票面「不硬造」纪律未做模板下拉，也未自造数据源：template_id 落自由文本经 POST 契约原样透传（后端语义：未登记 id 落机制默认档）。页面形态与六行对账不受影响；若 L0 要下拉式选模板，需阶段 2 补一条模板清单查询面（m2/m14 卡面），页面只换输入控件。
2. **m10 卡文字滞后**：m10 卡「公开接口：六个路由」与页面映射节第七页（票 71）文字上不再一致——本票不修 spec（spec 已定稿），路由快照测试注释已标明授权链（决策 #6 表外无路由 + 票 71/PRD §13.7 第七页）；建议阶段 E 体检对账时同步 m10 卡措辞。
3. 冒烟前置：compose 旧镜像无票 73 端点，重建了 case-backend/agent 两容器镜像后跑通（属环境准备非代码变更）；临时 vite dev :5174 已停，栈内 :5173 容器待下次 `docker compose build web` 收编代理行。
4. 页面 retryMs=300（流水线页 2000）：演示窗快退避，补发语义同一封装，./sse 零改动。

- **L0 验收（主窗口，2026-09-13）**：三闸亲跑 PASS + web 134/134 + 全量绿只增不减。偏差处置：①GET 模板清单面缺失→按纪律未硬造，template_id 自由文本透传（未登记 id 落机制默认档）；**模板清单查询面列阶段 E 体检候选**（需阶段 2 补卡：m14 卡或 m2 卡加一条 GET 面）；②m10 卡「六个路由」措辞滞后→L0 已同步为七个路由（本次收口一并落）；③打桩不引 MSW 库=照 m10 卡既有拍板双形态，接受。收尾五样齐。