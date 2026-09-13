# 92-templates-list-face: GET 模板清单查询面——狩猎页模板下拉（体检候选③，阶段 2 补卡）（P3）

**What to build:** 票 82 偏差①的收口（阶段 2 补卡，L0 已批）：模板登记面的公开只读投影。① agent 新增 `GET /api/v1/templates`（只读 L0 面：已登记模板清单 template_id/假设句式族/菜单子集/轮次上限——HuntTemplateSource 的投影，零业务逻辑）；② specs/modules.md m14 卡补该公开接口行、卡头"无独立 HTTP 面"改为"无独立写面（只读模板清单 GET 除外，票 92）"；③ web HuntingPage 模板选择从自由文本改为下拉（数据源走该面，adapter/打桩双形态照旧）；④ curl 平权脚本同步；路由快照零新增路由（页面已有）。

**铁律:** 只读投影零业务分支（R10：清单数据不是狩猎业务逻辑）；禁碰 m14 机制目录（服务面在 agent src 装配层）；前端零状态管理库；路由快照锁不破。

**Touches modules:** `m14`（公开接口补卡）、`m10`（web 消费）

**Belongs to spec:** specs/modules.md m14 卡（L0 补卡行）+ 页面映射节狩猎页"发起假设"行细化

**Blocked by:** 无

**Status:** ready

**验收：**
- [ ] GET /api/v1/templates 只读面在位（真后端 curl + 打桩单测双绿）
- [ ] m14 卡公开接口行补卡（L0 授权）；狩猎页模板下拉走该面（自由文本退位）
- [ ] 全量绿只增不减；路由快照零变化；双闸+零增量闸全绿

**实现记录：**（待填）
