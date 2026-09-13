# 88-scenario-s13-memory-hunting: 教学场景 S13：有记忆的狩猎（P2）

**What to build:** lessons/scenario/ 新增 S13（约 5 步 + big-picture.html）。主线：playbook_lookup 查剧本库（"三个月前有人猎过同款，Runbook 复用"）→ graph_query 查图谱（该 IoC 连过什么案）→ 命中旧案短路复用省轮次 → 毒剧本入库被拦（S5 的 RAG 投毒搬到摄取路径新 attack 面）。核心教学点：编排的**进化维度**（planner 消费面扩到知识源）+ 路由的**记忆增强**（选路依据 = 现场证据 + 历史研判）+ 跨仓分工（weknora 管知识平面 / soc-demo 管闸门，包层即闸门）。weknora 未对接时本票整体挂起（stub 形态不讲此场景，避免教半真功能）。

**铁律:** 同票 84；跨仓边界是教学重点之一——weknora 侧零安全闸的架构理由（两仓分工红线）必须讲透；毒 fixture 走查用票 83 的防线测试资产。

**Touches modules:** `m14`、`m11`、`m2`

**Belongs to spec:** PRD §13.5 ⑧；票 83 产出为本场景素材

**Blocked by:** 83

**Status:** done（2026-09-13 子 agent 施工 + L0 验收：13-0~13-5 六篇+大图 17 节点 4 安全闸（逐字节一致，weknora 侧虚线框标注票 83 对接后）+短路经济真栈实测（3 轮/192tok vs 2 轮/120tok，-37.5%）+INV-5 毒剧本三连真闸+总纲 S13 ✅（9-13 全 ✅）；零发现票）

**L0 派发前裁定（2026-09-13，用户令 84-88 全做且不互动，与本票"weknora 未对接整体挂起"铁律冲突，处置如下）：**
- 教学以 **stub 诚实形态** 进行，铁律精神（不教半真功能）靠显式标注守住：凡依赖 weknora 真源的段落（HTTP 对接面/摄取路径 attack 面/票 83 防线测试资产），文中显式标注「票 83 对接后回填」并指向挂起条件，**绝不冒充已对接**。
- 主线可教部分（全部是 stub 上的真实行为）：①playbook_lookup/graph_query 查本地剧本库与图谱 fixture（真数据真查询）②记忆命中→更准组合→更少轮次的短路经济（无记忆基线对照，真栈可测）③毒剧本防线=INV-5 真闸（hypothesis_register 只写 proposed、graph_query 只回 approved——投毒剧本 register 进来在检索面隐身，人审是唯一通道；这是现有真防线，不需要票 83 资产）④跨仓分工（weknora 管知识平面/soc-demo 管闸门，包层即闸门——架构叙事，MT-#83 对接期兑现）。
- 验收③"投毒入库走查"按上列③口径兑现（INV-5 亲手验证）；票 83 素材依赖部分在验收行下注记"回填条件=外仓三条件"。

**验收：**
- [x] S13 分步文章约 5 步落盘（复用短路 + 投毒拦截两条主线）
- [x] 跨仓分工图（知识平面/安全闸门边界）入 big-picture.html
- [x] 投毒入库走查的亲手验证步骤与预期断言
- [x] 导览总纲加 S13 行
- [x] 场景题闯关通过
- [x] TERMS 回指检查（票 89 词条已落）：业务模板与剧本库/图谱工具首现标 `TERMS「××」条`，回指 TERMS「编排循环」节（两者分家照词条口径）

**实现记录：**（2026-09-13，L2 编码窗，stub 诚实形态全程）

- ① **产物**：`lessons/scenario/13-0.md`（导览篇：S9-S13 第五副眼镜"进化维度"、教学句"记忆进菜单，毒进不了面"、**stub 诚实形态声明**前置、消费面扩容两级表、S5 续集衔接、五步路线+两捣乱预告）、`13-1.md`（菜单扩容=数据：真栈 c2 假设 hyp_265f157e 三轮轨迹轮 1 playbook_lookup 实测、预案卡 menu 真源+机制零 if/else、manifest 登记面 L0/L1+register 出组合菜单、hunt-prompt 起手式契约 tsx 渲染实测）、`13-2.md`（playbook_lookup 真查剧本库：4 张查询参考册走查、pb-c2-001 queries=waves 内容母本对照、执行四步舞签名契约→闸→lookup→观察、防全库捞契约、真栈审计表对账轮 1 total=1、剧本库只读零写口=stub 诚实边界）、`13-3.md`（graph_query 旧案记忆走查 seed:ir-2023-041、**短路经济对照实验**：runHuntScene 契约级布景无记忆基线 3 轮 192 tok vs 记忆知情 2 轮 120 tok（省的恰是 total=0 盲查轮）+空图谱对照 total=1→0、两条诚实边界〔fake 不消费结果/真 LLM 闭环=回填段〕、三道 filter status 在最前）、`13-4.md`（**INV-5 真闸三连实测**：工具面直投 403 no_ticket→缝面投递 record.status=proposed→graph_query 查毒 total=0→五要素审计留痕；闸的两面落法表、状态字类型面无翻 approved 通道、S5↔S13 两代投毒防线对照表、seed 常驻毒探针 T22 负例）、`13-5.md`（**捣乱①**：伪造 approved 关系塞 fixture→graph_query 读面吐出→committed 测试 expected 2 to be 1 当场红→还原 11 passed 零残留；信任边界表"INV-5 牙在写侧"；跨仓分工红线（weknora 侧零安全闸=架构）+seam 换件缝+**票 83 回填清单七项显式挂起**（外仓三条件）；S5↔S13 对照表；收官回归一条龙）。
- ② **亲手验证（全实跑）**：真栈主线 POST :3002 假设 201→三轮轨迹（hyp_265f157e c2 基线 3 轮/hyp_bd7cd73b webshell 2 轮含 graph_query total=1）→M2 audit_entries hunt_task_report total=N 逐轮对账；契约级 tsx 五件（菜单渲染/剧本查询/图谱+短路经济/空图谱/毒 register）；committed 回归 weknora.test 11 passed+hunt-pack.test 全绿（32/32 合跑）+`pnpm test:eval` 40 passed。
- ③ **发现缺陷转票**：无——零就地修；run-kinds.ts 铸票缝行号实测修正（TERMS 词条 347-349→实测拒铸 throw :351，文中按实测标注）。
- ④ **纪律自证**：零生产代码改动（git diff 仅票面+总纲，fixtures/services/evals 零 diff）；捣乱①改 graph.json 当场还原 `git diff --name-only fixtures/ services/ evals/`=0；45 处 #L 引用逐一与源文件比对全绿（含内容关键词抽查 41 处）；大图 style 块+3 个 script 块与 2-big-picture.html **逐字节一致**（python 切片 style True+scripts [True,True,True]）；mermaid@11+jsdom parse 验证通过（flowchart-v2，2 号图同跑作对照；修一处 `--"…"-.->` 混线语法）；图文对齐 8 条遵守（速览段三块+17 节点四栏明细表全量+子图进入/节拍/退出三段+跨容器边带 跨容器→case-backend:3002 标签+4 安全节点红框🛡️+INV 编号〔INV-5 毒剧本真闸=INV5_GATE 必登记〕+文档 📍 锚点=节点 ID+weknora 侧虚线框标注"票 83 对接后"+灰虚线未接线边）。
- ⑤ **收尾三闸**：`check_specs.py` PASS（0 警告）、`check_boundary.py` PASS（0 越界 12/12）、`check_zero_increment.py` PASS（diff 9 文件×机制层 5 领地交集 0）。
- ⑥ **stub 诚实形态兑现**：文中凡依赖 weknora 真源段落显式标注「票 83 对接后回填」并指向挂起条件（13-0 声明/13-2 检索语义+摄取面/13-3 真 LLM 消费闭环/13-4 人审通道端点+摄取 attack 面/13-5 七项清单表），绝不冒充已对接；教学主线全部为 stub 上真实行为（真数据真查询真闸）。

- **L0 验收（主窗口，2026-09-13）**：三闸 PASS（含零增量）+ 大图逐字节亲跑 True + 总纲 S13 ✅（84-88 收官）。L0 裁定四条兑现核对：stub 诚实形态（回填标注七项清单+挂起条件逐字指向票 83）/INV-5 真闸不需要票 83 资产/捣乱①教点（fixture 造数据≠人审通道，INV-5 的牙在写侧）诚实且深刻。短路经济数字与诚实边界（fake 档组合来自 waves）标注到位。收尾五样齐。**S9-S13 五场景至此全部收口，教学链完成。**