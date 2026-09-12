# 83-weknora-integration: weknora 对接——三工具 HTTP 实现换 stub（P2）

**What to build:** 把票 79 的 Memory stub 换成 weknora 真实现。**前置外仓条件：weknora复刻完成「1.5 HTTP API 幕」（FastAPI：/ingest /search /graph/query）与第二幕 SOC 实体图谱**——未就绪则本票挂起，stub 形态功能完整不受影响（seam 设计的本来目的）。① 三客户端实现：`playbook_lookup` → weknora /search（剧本库 wiki 幕）；`graph_query` → weknora /graph/query（实体=假设/证据/IoC/案件的关系查询）；`hypothesis_register` → weknora /ingest（假设+证据关系入图，**soc-demo 包层先过人审闸——INV-5 口径：未人审的假设只进 proposed 面不进检索面**）；② env 开关装配（WEKNORA_URL 设定才换真实现，未设=stub 逐字节不变——jiaotu profile 同款开关纪律）；③ 投毒面测试复用：毒剧本/毒假设入库路径全量过现有防线（攻击 fixture 搬移到摄取路径）。

**铁律:** weknora 侧不做任何安全闸（两仓分工红线：它只管知识平面）；包层即闸门——soc-demo 侧人审/扫描/审计一件不能省；开关两形态同仓共存，不开 git 分支。

**Touches modules:** `m14`（仅换 adapter 装配）、`m2`（stub 退役路径）

**Belongs to spec:** specs/orchestration-loop.md（行号回填同上）；weknora 仓改线版 PLAN（外仓产物，另票跟踪）

**Blocked by:** 79 + weknora 外仓 1.5 幕与第二幕完成（外仓条件，非本仓票可解）+ **weknora 改线版 PLAN.md**（用户拍板 2026-09-12：等本仓票 72 spec 定稿后动，两边先对实体模型接口）

**Status:** blocked

**验收：**
- [ ] 三工具真实现契约测试与 stub 全同（调用方零改动验证）
- [ ] WEKNORA_URL 开关两形态回归零差异
- [ ] 未人审假设检索面不可见（INV-5 跨仓断言）
- [ ] 毒 fixture 摄取路径防线全绿
- [ ] weknora 挂掉时 fail-closed（INV-1：查询失败 ≠ 无结果，降级语义测试绿）

**实现记录：**（待填）
