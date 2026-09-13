# 92-templates-list-face: GET 模板清单查询面——狩猎页模板下拉（体检候选③，阶段 2 补卡）（P3）

**What to build:** 票 82 偏差①的收口（阶段 2 补卡，L0 已批）：模板登记面的公开只读投影。① agent 新增 `GET /api/v1/templates`（只读 L0 面：已登记模板清单 template_id/假设句式族/菜单子集/轮次上限——HuntTemplateSource 的投影，零业务逻辑）；② specs/modules.md m14 卡补该公开接口行、卡头"无独立 HTTP 面"改为"无独立写面（只读模板清单 GET 除外，票 92）"；③ web HuntingPage 模板选择从自由文本改为下拉（数据源走该面，adapter/打桩双形态照旧）；④ curl 平权脚本同步；路由快照零新增路由（页面已有）。

**铁律:** 只读投影零业务分支（R10：清单数据不是狩猎业务逻辑）；禁碰 m14 机制目录（服务面在 agent src 装配层）；前端零状态管理库；路由快照锁不破。

**Touches modules:** `m14`（公开接口补卡）、`m10`（web 消费）

**Belongs to spec:** specs/modules.md m14 卡（L0 补卡行）+ 页面映射节狩猎页"发起假设"行细化

**Blocked by:** 无

**Status:** done

**验收：**
- [x] GET /api/v1/templates 只读面在位（真后端 curl + 打桩单测双绿）
- [x] m14 卡公开接口行补卡（L0 授权）；狩猎页模板下拉走该面（自由文本退位）
- [x] 全量绿只增不减；路由快照零变化；双闸+零增量闸全绿

**实现记录：**（2026-09-13 落，自主档 TDD；票 82 偏差①收口）

**产物**
- `services/agent/src/app.ts`：①`GET /api/v1/templates` 只读路由（鉴权口径照抄既有公开读面 GET /api/v1/approvals——无中间件）；②`TemplateListRow` wire 类型 + `toTemplateListRow()` 投影函数（字段名照模板文件原样：template_id/假设句式族 hypothesis_patterns/菜单子集 menu/轮次上限 max_rounds，只挑票面四字段，waves/example_slots 等内容层查询计划不外发）；③buildApp 增 `templates?: () => TemplateListRow[]` 数据源 seam（未传 = `{templates: []}`，未登记不报错）。投影零业务分支（R10：清单数据不是狩猎业务逻辑，读出即返回）。
- `services/agent/src/index.ts`（装配层）：模板登记面提为具名单例 `huntTemplates`（同一实例两路消费——编排循环 ORCH_DEPS.templates 不变 + buildApp seam `() => huntTemplates.all.map(toTemplateListRow)`）。HuntTemplateSource（workers/investigation/hunt-pack.ts）与机制格式契约（orchestration/template.ts）只 import 消费，零改动。
- `services/agent/src/templates.test.ts`（新，4 例）：未注入 seam → 200 空数组；seam 给什么回什么（零业务分支 + 每请求一取）；投影字段名照模板文件原样且内容计划不外发；装配级对账——真登记面（fixtures/hunt-templates）上线即出票 79 三族 + 票 80 ir 四模板（装载按 template_id 排序口径钉死）。
- `services/web/src/api.ts`：`listHuntTemplates()` 客户端 + `HuntTemplateRow` 类型（wire 原样透传零加工，票 91 eval purple 同款口径；缺 templates 键 → 空数组，面病了原样抛 ApiError）。
- `services/web/src/pages/HuntingPage.tsx`：模板选择从自由文本 Input 改为 **Select 下拉**（票面允许形态自定，本票声明：下拉为主、allowClear 留空 = 机制默认档，自由文本退位；下拉项 = `template_id（上限 N 轮）`，句式族作 title 悬浮提示）。清单空/面不可达 → notFoundContent 如实占位「模板清单不可用（未登记/面不可达）— 留空走机制默认档」，页面不炸不硬造数据源（票 82「不硬造」纪律延续）。文件头「模板选择口径」段同步改写。
- `services/web/vite.config.ts`：代理表补 `/api/v1/templates` → agent（票 55 vite-proxy 静态对账闸强制——api 层新增前缀必配行，否则走线断在 vite 自身；票 82 补 `/api/v1/hypotheses` 行同一先例）。**页面路由快照零变化**（routes.ts/routes.test.ts 零触碰，七页不变）。
- 测试：`api.test.ts` 增 3 例（GET 路径+原样透传/缺键空数组/500 抛 ApiError）；`pages.test.tsx` 改 1 例（发起假设经下拉选模板，POST 体仍带 template_id）+ 增 2 例（下拉项=登记面投影+留空 POST 不带 template_id；面病 500 → 空清单降级、列表与发起链路照常）。
- `scripts/hunt-smoke-82.sh`：头部面清单增模板下拉行 + 新增「步骤 0」模板清单拉取（GET /api/v1/templates 经 ：5173 同源代理，断言 templates 键 + 票 79 三族可见）。
- `specs/modules.md`：m14 卡头「无独立 HTTP 面」→「无独立写面——只读模板清单 GET 除外，票 92」；公开接口节补 GET 行；顶部沿革补 2026-09-13 票 92 补卡注；页面映射「发起假设」行补下拉数据源（写+读）。

**验收证据（票面三条）**
- 只读面双绿：真后端 `docker compose build agent && up -d` 后 `curl http://127.0.0.1:3003/api/v1/templates` → 200 四模板（hunt_c2_beacon/hunt_credential_leak/hunt_webshell + ir_host_compromise，字段 template_id/hypothesis_patterns/menu/max_rounds）；渠道平权 `curl http://127.0.0.1:5173/api/v1/templates`（同源代理）同答。打桩单测：agent templates.test.ts 4/4 绿 + web api/pages 5 例绿。
- m14 卡补卡 + 下拉走面：见上产物与 modules.md diff；下拉数据源经 listHuntTemplates → 只读面，自由文本退位（票内声明）。
- 全量绿只增不减：根 `pnpm test` 全 workspace 绿（agent 68 files/704 passed+3 skipped、web 16 files/143 passed、eval 33/33、其余包原数）——本票净增 agent +4、web +5，仅 1 例改造（发起假设的模板交互）未减。路由快照：routes.test.ts 七页断言原样绿。双闸 `check_specs` PASS（0 警告）/`check_boundary` PASS（0 越界，12/12）；零增量闸 PASS（diff 10 文件 × 机制层 5 领地：交集 0）——未触发「闸报红回报声明」分支。

**记入偏差（如实）**
1. **vite.config.ts 代理行**：票面只许动清单未点名 vite.config.ts，但票 55 静态对账闸（vite-proxy.test.ts）对 api 层新增前缀强制配行（缺行 = 单测绿而走线断，票 55 事故原样重演）——属 ③ web 消费的必要接线，先例 = 票 82 的 `/api/v1/hypotheses` 行。有测试闸咬住，非自扩权。
2. **「出三模板」与实际四模板**：票面验收写「出三模板」（票 79 三族口径），真后端实际出四——票 80 的 ir_host_compromise 已在同一登记面（登记面天然含全部已登记模板，投影不筛业务族）。冒烟断言按「三族必在」（脚本），单测钉死全量四条。
3. **真后端冒烟做了容器重建**：compose 栈的 agent/web 是本地源码构建镜像（票面冒烟要求真后端出线），`docker compose build agent web && up -d` 属标准开发回路；:3003 直连与 ：5173 同源代理两路 curl 均验证。hunt-smoke-82.sh 全脚本未整跑（其步骤 1-5 会经真 LLM 拉起完整狩猎轮次，非本票冒烟范围；步骤 0 的断言已逐条 curl 复现）。

- **L0 验收（主窗口，2026-09-13）**：双闸+零增量闸 PASS + agent 704|3skip + web 143 全绿（补跑记录：L0 提交命令链 cwd 失误致闸跑在提交后，本行即补跑凭证——内容与闸全绿）；偏差①（vite 代理行=票 55 静态对账闸强制）②（四模板含 ir——投影不筛业务族，冒烟改三族必在断言）③（冒烟容器重建、smoke 脚本步骤 0 逐条 curl 复现）均接受。收尾五样齐。**体检候选③销账，三候选全部清偿。**