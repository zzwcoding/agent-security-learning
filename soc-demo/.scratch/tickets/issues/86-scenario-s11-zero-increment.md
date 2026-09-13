# 86-scenario-s11-zero-increment: 教学场景 S11：第二个业务零增量（P2）

**What to build:** lessons/scenario/ 新增 S11（约 4 步 + big-picture.html）。主线：现场走一遍应急取证模板落地全过程——只看 git diff 不触 m14 的断言怎么跑、模板文件长什么样、菜单收窄后 planner 的选路空间怎么变。核心教学点：编排的**架构维度**——"编排逻辑"与"业务内容"解耦的证明课不是功能课；动态路由的选路空间由业务模板圈定（应急模板里 planner 看不见 web 工具）。教学句："动态性是有边界配置的"。捣乱实验：故意想给应急模板加特权——发现该加的是工具不是循环（回票 78 菜单位）。本场景是 S7（新增一个工具，登记先于代码）的姊妹篇：同一"约定先于实现"纪律在内容层再演示一次。

**铁律:** 同票 84；零增量断言（diff 与机制层交集为空）作为本场景第一幕亲手跑给用户看。

**Touches modules:** `m14`（只读消费）、`m10`

**Belongs to spec:** PRD §13.1 分层铁律；票 80 的架构验收断言（本场景是其教学化）

**Blocked by:** 80

**Status:** done（2026-09-13 子 agent 施工 + 待 L0 验收：11-0~11-4 五篇 + 11-big-picture.html 15 节点 3 安全闸（style/script 与 2 号图逐字节一致）；零增量闸亲跑三连（self-test 14/14 + 本票真实 diff 绿 + 机制层一行红样本还原零残留）；ir 假设真栈 4 轮 concluded 建案 case_000018；27 件菜单外工具 100% offmenu 拒；总纲 S11 ✅；零发现票）

**验收：**
- [x] S11 分步文章约 4 步落盘，零增量断言第一幕亲手验证（11.2：self-test 14/14 + 工作树绿 + 真实 diff 8 文件×5 领地交集 0 + 捣乱②红样本）
- [x] 模板文件结构与菜单配置讲透（学习者照做可加第三业务——11.4 场景题 Q2 给出第三业务动工清单）
- [x] big-picture.html 出图（数据模板→装载→循环→零增量闸视觉主线；机制层 m14 黑盒）
- [x] 导览总纲加 S11 行（翻 ✅）；与 S7 的姊妹篇关系写出（11-0 定位 + 11-4 收官对照表）
- [x] 场景题闯关通过（6 道：11.1 一道/11.2 一道/11.3 一道/11.4 两道+对照表）
- [x] TERMS 回指检查（票 89 词条已落）：预案卡/派工菜单/侦查怀疑书/查证轮/单趟差/循环三件套/撒出去·收回来首现标 `TERMS「××」条`，回指 TERMS「编排循环」节（预案卡与 weknora 剧本库分家照词条口径在 11-0 与 11-1 各回指一次）

**实现记录：**（2026-09-13，L2 自主完成）

① **产物**：`lessons/scenario/11-0.md`（导览篇：S7 姊妹定位"加工具要登记→加业务只要数据"、分层三层表、教学句"动态性是有边界配置的"）、`11-1.md`（预案卡逐段拆：ir_host_compromise.json 33 行全段落行号、装载链 loadHuntTemplates/HuntTemplateSource/toLoopTemplate 只投影机制四字段、真栈 GET :3003/api/v1/templates 四卡实测、捣乱①塞 web_access_query→收窄对账红+两绿对照"不缺登记不涨票面红的是业务边界"+还原零残留）、`11-2.md`（零增量闸亲跑：PROTECTED 五领地/否定式断言/fail-closed、self-test 14/14、本票真实 diff 8 文件×5 领地交集 0、捣乱②机制文件 planner.ts 改一行→当场红 exit 1 点名领地→还原 git diff 零残留回绿）、`11-3.md`（ir 假设端到端：真栈主线 hyp_79281df7 四轮 playbook→proc_lineage→file_change→outbound+graph 全程 concluded hit 建案 case_000018+遏制建议 note 原文、fake 解释器三步（族签名→查 waves→槽位渲染）零专属代码、契约级 tsx 逐轮一致、反事实小实验"无关文本轨迹不变"）、`11-4.md`（菜单收窄语义：27/27 offmenu_tool 零重试遍历实测、三道闸一致性、遏制建议零 ApprovalToken、S7↔S11 收官对照表+第三业务动工清单题）；`11-big-picture.html`（15 节点/3 安全闸/6 子图，主视觉线=数据模板→装载→循环→零增量闸，机制层黑盒+说明性暗灰节点）。

② **亲手验证（真栈 AGENT_LLM=fake 全实跑）**：真栈 ir 怀疑书 hyp_79281df7-0c6a-462e-9592-a30540c99a6e（POST :3002，201）四轮轨迹逐轮与模板 waves 一致 → concluded(hit 0.8) → case_000018 挂 hypothesis_id → 遏制建议进 note（"隔离主机 centos7（L2 动作：…须经人工审批后由审批回路执行）"原文在账）→ approvals/used_tokens 零新增（建议≠授权实证）；GET :3003/api/v1/templates 四卡在册；27 格菜单外遍历 27/27 DENIED（契约级 tsx）；零增量闸 self-test 14/14 + 工作树绿 + 捣乱②红→还原绿；ir-template.test.ts 16 passed 复跑、evals hunting.test.ts 4 passed 复跑。

③ **发现缺陷转票**：无——本票期间零新缺陷（对账测试在捣乱①下的表现=按设计红，红样本均已还原零残留）。

④ **纪律自证**：零生产代码改动（涉文件=6 新增文档+总纲 S11 行+本票实现记录）；全程无 git 写操作（闸与还原自证用只读 diff/status）；行号全部实测核对（ir_host_compromise.json/hunt-pack.ts/template.ts/index.ts/run-kinds.ts/planner.ts/check_zero_increment.py/ir-template.test.ts/hunting.ts/orchestration-loop.md/prd.md 逐处 grep）；大图 style 块与 3 个 script 块与 2-big-picture.html **逐字节一致**（python 正则切片双 True）；mermaid 块经 mermaid@11+jsdom parse 验证通过（9-big-picture 同跑作对照）；📍 大图锚点 15 节点与文中节点 ID 一致。

⑤ **收尾双闸**：`python3 tools/check_specs.py` PASS（0 警告）、`python3 tools/check_boundary.py` PASS（0 越界）——文档票零生产影响确认；零增量闸对本票最终 diff PASS（8 文件 × 5 领地：交集 0）——**文档票本身就是"内容层增量零触机制"的活样本**。

**Status:** done

- **L0 验收（主窗口，2026-09-13）**：双闸 PASS + 零增量闸对本票 diff PASS（内容层增量零触机制的活样本）+ 大图逐字节亲跑 True + 总纲 S11 ✅ 核对 + git 清单恰 8 项全在授权面。步序说明（票面铁律 vs 任务单步序）接受——导览篇已把零增量立为第一主张。捣乱②红样本还原零残留核对。S7↔S11 姊妹关系落 11-0/11-4。收尾五样齐。