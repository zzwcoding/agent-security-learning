# 84-scenario-s9-hypothesis-lifecycle: 教学场景 S9：一个假设的一生（P2）

**What to build:** lessons/scenario/ 新增 S9（约 6 步 + big-picture.html）。主线：假设五态（proposed→hunting→concluded/refuted/cancelled）→ planner 选组合 → 扇出 2 子 run 并行取证 → judge 收敛 → gap 驱动第二轮换组合（C₂≠C₁ 画在轮次视图上）→ 命中建案/未命中证伪归档。核心教学点：多 agent 编排与动态路由的**正面展示**——"下一步查什么取决于这一步查到什么"从口号变直播画面。捣乱实验：① hunting 态取消——子任务安全停还是带病跑；② 预算烧光——状态落 cancelled 不冒充 refuted。场景题闯关 + TERMS 词条回指（词条本体归票 89）。

**铁律:** learn-by-rebuild 场景导览纪律（TERMS 比喻/亲手验证/捣乱实验/不改生产代码，发现 bug 转票）；每步文章带 文件:行号 指针（行号实测非凭记忆）；新术语解释永远回指 TERMS 同一处。

**Touches modules:** `m14`、`m2`、`m10`

**Belongs to spec:** PRD §13（事实底座）；lessons/scenario/00-导览总纲.md 场景清单加行

**Blocked by:** 79

**Status:** blocked

**验收：**
- [ ] S9 分步文章 6 步左右落盘，覆盖五态全轨迹 + 轮次视图解读
- [ ] 捣乱实验两个（取消/超预算）有亲手验证步骤与预期断言
- [ ] big-picture.html 出图（planner→扇出→judge→gap 回路 + 五态）
- [ ] 导览总纲场景清单加 S9 行；场景题闯关通过
- [ ] 与 S1（告警的一生）的结构呼应显式写出（被动链 vs 主动环）

**实现记录：**（待填）
