# 87-scenario-s12-purple-team: 教学场景 S12：紫队闭环——系统自证 2.0（P2）

**What to build:** lessons/scenario/ 新增 S12（约 5 步 + big-picture.html）。主线：attack fixture 自动转假设（系统行为，actor=system）→ 循环无人值守跑 plan→扇出→judge → ground truth 判发现/未发现 → 未发现的出盲区报告（哪条证据链缺失）→ 自主发现率表 + 换 seed 复跑验证可复现。核心教学点：编排的**自主维度**（端到端任务执行的最硬证据）+ 动态路由的**质量维度**（攻击路径不可知，静态剧本必漏，自主发现率是比 33/33 拦截率更高一级的自证）。本场景是 S8（系统自证）的升级版："挨打能防"→"主动能抓"。

**铁律:** 同票 84；自主发现率口径教学化讲清（预算内/轮次内/ground truth 断言判定，防"无限烧 token 必发现"的注水质疑——这是本场景必被问的点）。

**Touches modules:** `m11`、`m14`、`m5`

**Belongs to spec:** PRD §13.5 ⑥（指标口径）；票 81 产出数字为本场景素材

**Blocked by:** 81

**Status:** done（2026-09-13 子 agent 施工 + 待 L0 验收：12-0~12-5 六篇 + 12-big-picture.html 17 节点 4 安全闸（style/script 与 2 号图逐字节一致）；cli 真跑自主发现率 5/11 + 复现三连（rig 双跑/cli 两遍/换 seed，digest 全等）+ 判定机器语义走查（judge 半判据 ∧ 签名三重验）+ 盲区聚类 2 族 6 维（credential_leak 0/4 最弱）+ 捣乱两件（ground truth 投毒发现判定翻转对账红/预算注水 999999 行为零变化口径留痕，均还原零残留）；总纲 S12 ✅；零发现票）

**验收：**
- [x] S12 分步文章约 5 步落盘（含一次"未发现→盲区报告"完整走查）——12-0~12-5 六篇；12.4 逐例盲区三件套全文走查 + 聚类 2 族 6 维
- [x] 换 seed 复跑的亲手验证步骤与数字可复现断言——12.2 复现三连：rig 双跑 replayDigestEqual + cli 两遍跨进程 digest ALL EQUAL + 换 seed 复跑 digest 逐字节不变（还原零残留）
- [x] big-picture.html 出图（fixture→假设→循环→发现率表）——17 节点/4 安全闸/5 子图，主视觉线=attack fixture→映射→循环→ground truth 判定→发现率/盲区
- [x] 导览总纲加 S12 行（翻 ✅）；与 S8 的升级关系写出——12-0 定位 + 12-5 十行对照表 + "防线满分狩猎不及格"误读的因果课
- [x] 场景题闯关通过（含注水质疑的应答题）——6 道：12.1 一道/12.2 一道/12.3 注水质疑应答（Q3 两层质疑分别对挡）/12.4 一道/12.5 两道+收官
- [x] TERMS 回指检查（票 89 词条已落）：自主发现率/假设首现标 `TERMS「××」条`，回指 TERMS「编排循环」节（预算内/ground truth 口径照词条）——六篇 TERMS 引用 grep 审计全过（无人值守破案率 11 处/侦查怀疑书 5 处/查证轮·单趟差·撒出去收回来·循环三件套·派工菜单·预案卡各按首现标条）

**实现记录：**（2026-09-13，L2 自主完成）

① **产物**：`lessons/scenario/12-0.md`（导览篇：S8→S12 升级定位"挨打能防→主动能抓"、三级自证台阶表〔拦截率/自主发现率/盲区报告〕、五步路线、教学句与两个必考点〔判卷口径/预算口径〕预告）、`12-1.md`（映射表逐段拆：表头两行注释=全场景口径、02 例七字段逐段、ground truth 三键〔expected/signatures/blind_spot〕判卷半边、装载 fail-closed 两规矩+yaml attack 同源对账、tsx 实测 11 例现场逐例渲染成怀疑书、捣乱〔布景级·仅 /tmp〕删签名装载当场拒点名到例）、`12-2.md`（cli 入口真跑：`pnpm test:eval` 40 测试 2 文件、汇总行 `purple discovery_rate=5/11（盲区聚类 2 族，最弱=credential_leak）`、逐例 11 行表〔5 discovered/6 refuted、2-4 轮全在预算内〕、复现三连：rig 双跑 replayDigestEqual 列全真+cli 两遍跨进程 digest ALL EQUAL+换 seed 复跑 digest 逐字节不变〔布景零 RNG、seed=布景版本常量〕均还原零残留）、`12-3.md`（发现判定机器语义：`discovered = judge hit ∧ 签名三重验`逐字读、三重验逐腿拆〔①轨迹执行②取证面 total>0（INV-8 审计真相源）③corpusHasTrace 独立读语料〕、groundTruthOk 对账闸、预算双取小+cancelled 不冒充发现、八项场景专项检查、corpusHasTrace 真假对照实测、**捣乱①**：02 例签名 value 改成格式合规的假路径→发现判定翻转（5/11→4/11）但行为零变化 digest 不变、judge 仍 hit、失真例点名到腿（"签名查询未被执行"）、4 测试红含 hit 名单快照→还原零残留复跑回绿）、`12-4.md`（盲区报告走查：01 例盲区三件套全文〔loopGap 循环侧真产物+映射表标注两派合流〕、盲区聚类 2 族 6 维原文（credential_leak 0/4 最弱：auth 探测/知识内容/L2 执行审计/凭证外带四维+c2 的沙箱回流/对话决策面两维）、"全部非 SIEM 工具维度"的共同形状、0/4 的正确用法、**捣乱②**：硬顶 20→999999 注水→6 测试照绿、发现率 5/11 纹丝不动、digest 逐字节不变、绑定档 min(999999,6)=6 不变、budgetDetail"硬顶 999999"如实留痕→还原零残留）、`12-5.md`（收官：:5173 容器烤制 latest.json 紫队段与宿主重跑产物对账一致、web Eval 页紫队小节〔EvalPage.tsx:118-145 纯投影〕、S8↔S12 十行对照表、"防线满分狩猎不及格"误读的因果课〔防住了→没痕迹→只能证伪〕、四工件去处表、收官回归一条龙）。

② **亲手验证（全实跑，快道口径与 8.1 同源：eval 零读 AGENT_LLM 不进容器）**：`pnpm test:eval` 三跑（19:43 两遍+收官一遍）33/33 零回归+purple discovery_rate=5/11；**复现实验**：run0（票 81 存量产物 10:34）vs runB（11:43）vs runC（11:44）11 例 digest ALL EQUAL（rig 内逐例双跑 replayDigestEqual 另证）——同 seed 同结果三份独立产物背书；换 seed（purple-s12-teaching-swap）复跑 6 测试全绿 digest 与换前 ALL EQUAL、还原后产物 seed 回 purple-81-v1；corpusHasTrace 真假对照（sh.php=true/nope.php=false）；tsx 实测 11 例映射渲染（11 目录↔11 mappings↔seed 三数对上）；web :5173 紫队段亲 curl（discovered 5/fixtures 11/weakest credential_leak）与宿主产物逐项相等；收尾全量 `pnpm test:eval` 40 passed 回默认态。

③ **发现缺陷转票**：无——本票期间零新缺陷（捣乱①②与换 seed 的红/绿表现均按设计：对账红点名到例、注水照绿但口径留痕、seed 漂移无断言属"布景版本常量"设计而非缺陷；三处改动全部还原、git diff 零残留自证）。

④ **纪律自证**：零生产代码改动（工作树=7 新增文档/图+总纲 S12 行一处，evals/fixtures/services 零 diff——git 零残留自证三连：hypothesis-map.json、purple.ts、映射表副本各 checkout 还原后 `git status` 对应目录零输出）；行号全部实测核对（41 个 `#L` 引用逐一与源文件行内容比对脚本全绿+hunting.ts 三处初稿行号偏差当场修正 431→426/436→430/424→418）；大图 style 块与 3 个 script 块与 2-big-picture.html **逐字节一致**（python 正则切片，style True+scripts [True,True,True]，与 11 号图三方对齐）；mermaid 块经 mermaid@11+jsdom parse 验证通过（9-big-picture 同跑作对照）；图文对齐 8 条遵守（速览段三块+17 节点四栏明细表全量+子图标题进入/节拍/退出三段+边标一动作一时序+安全节点红框🛡️+INV/决策编号+文档📍锚点=节点 ID+本图无跨容器红边〔快道进程内，如实声明〕）；📍 大图锚点与文中节点 ID 一致（ATTACK_FIXTURES/MAP/T_CORPUS/RIG/ROUND_CHAIN/FAKE_LLM/MENU_GATE/CHILD_RUN/GT_GATE/BUDGET_GATE/REPRO/TABLE/WEB_EVAL/T_ARTIFACTS〔=T_PURPLE+T_LATEST〕）。

⑤ **收尾三闸**：`python3 tools/check_specs.py` PASS（0 警告）、`python3 tools/check_boundary.py` PASS（0 越界 12/12）——文档票零影响确认；`python3 tools/check_zero_increment.py` PASS（本票 diff 8 文件×5 领地交集 0——紫队教学文档本身就是"内容层增量零触机制"的再一样本）；`.scratch/lesson-lint.py` 六篇全绿（无 📄 标签=与 S9-S12 成熟形态一致）。

**Status:** done（2026-09-13 子 agent 施工，待 L0 验收）

- **L0 验收（主窗口，2026-09-13）**：三闸 PASS（含零增量）+ 大图逐字节亲跑 True + 总纲 S12 ✅。复现实验四方 digest 全等（票 81 存量产物 vs 本次三跑）——「同 seed 同结果」从口径变成实测。捣乱①投毒翻转发现率但循环行为零变化（失真点名到腿）= ground truth 资产脆弱性的诚实展示；捣乱②注水 999999 数字纹丝不动+budgetDetail 如实留痕=口径守卫真咬合。收尾五样齐。