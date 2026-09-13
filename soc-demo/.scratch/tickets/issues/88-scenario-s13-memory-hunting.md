# 88-scenario-s13-memory-hunting: 教学场景 S13：有记忆的狩猎（P2）

**What to build:** lessons/scenario/ 新增 S13（约 5 步 + big-picture.html）。主线：playbook_lookup 查剧本库（"三个月前有人猎过同款，Runbook 复用"）→ graph_query 查图谱（该 IoC 连过什么案）→ 命中旧案短路复用省轮次 → 毒剧本入库被拦（S5 的 RAG 投毒搬到摄取路径新 attack 面）。核心教学点：编排的**进化维度**（planner 消费面扩到知识源）+ 路由的**记忆增强**（选路依据 = 现场证据 + 历史研判）+ 跨仓分工（weknora 管知识平面 / soc-demo 管闸门，包层即闸门）。weknora 未对接时本票整体挂起（stub 形态不讲此场景，避免教半真功能）。

**铁律:** 同票 84；跨仓边界是教学重点之一——weknora 侧零安全闸的架构理由（两仓分工红线）必须讲透；毒 fixture 走查用票 83 的防线测试资产。

**Touches modules:** `m14`、`m11`、`m2`

**Belongs to spec:** PRD §13.5 ⑧；票 83 产出为本场景素材

**Blocked by:** 83

**Status:** blocked

**验收：**
- [ ] S13 分步文章约 5 步落盘（复用短路 + 投毒拦截两条主线）
- [ ] 跨仓分工图（知识平面/安全闸门边界）入 big-picture.html
- [ ] 投毒入库走查的亲手验证步骤与预期断言
- [ ] 导览总纲加 S13 行
- [ ] 场景题闯关通过
- [ ] TERMS 回指检查（票 89 词条已落）：业务模板与剧本库/图谱工具首现标 `TERMS「××」条`，回指 TERMS「编排循环」节（两者分家照词条口径）

**实现记录：**（待填）
