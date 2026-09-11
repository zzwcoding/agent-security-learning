# 60-teaching-supplement-diagram-alignment: 教学增补与图文对齐（五原则落地 + 行号校准合并）（P2）

**What to build:** 学习者跟场景 1 文档+大图学 1.1-1.4 的卡点复盘（2026-09-11）已沉淀为机制：learn-by-rebuild"叙述完备性五原则"、soc-diagram-conv"图文对齐约定"、`lessons/scenario/TERMS.md` 术语表。本票把**存量产物**按新机制增补对齐。范围与优先级：

1. **P1 · 1-1..1-4 增补**（学习者正在学）：
   - 每站开头加 `📍 大图节点:<NODE_ID>(<子图名>)`（对齐 8-scenarios-big-picture.html 现有节点 ID，如 1.3 站 3→`A_LAUNCH`/`RUN_ENQUEUE`）
   - 1.3 补"**时序接缝**"段：202 秒回那一刻 HTTP 结束、run 行 queued+run_jobs 行 pending 落库、0~100ms 无事发生、派活循环下一 tick 领走；"202 是给调用方的回执，派活循环只认 run_jobs 表"
   - 1.4 kb_check 等动作补"为什么做这一步/不做会怎样"三件套
   - 各篇开头加 `[术语表](TERMS.md)` 链接
2. **P1 · 大图 HTML**：`<h1>` 后加速览段（图是什么/怎么读/最常问入口 5 条，纯静态 div 不动 JS）+ 场景 1 节点明细表（`节点ID|干什么|为什么|下游`，先覆盖 1.1-1.4 节点）
3. **P2 · 2-1..2-4/3-4 行号漂移校准**（票 50/51 衍生，总纲学习日志 2026-09-10 已备案的那笔）：插入点之后的引用块行号与 #L 链接刷新为当前 HEAD 实测行号（机检 lesson-lint.py 逐篇跑绿为准）；不改引用内容
4. **P3 · 5-1..8-5 增补**：后续学习者跟到哪补到哪（不一次做完）

**Touches modules:** 无（纯 lessons/scenario/ 教学文档 + 大图 HTML）

**Belongs to spec:** lessons/scenario/00-导览总纲.md（文章模板五原则增补）

**Blocked by:** 无（机制已落盘：learn-by-rebuild 五原则、soc-diagram-conv 图文对齐约定、TERMS.md）

**Status:** ready

**验收：**
- [ ] 1-1..1-4 每站有 📍 节点行，节点 ID 与大图 HTML 实际节点名逐一对应（grep 核对）
- [ ] 1.3 时序接缝段落存在且数字准确（100ms/2s 周期与代码一致）
- [ ] 1-1..1-4 开头有 TERMS.md 链接；TERMS 比喻与文章内用词一致（无第二套比喻）
- [ ] 大图速览段与节点明细表就位；HTML/JS 部分零改动（diff 只在速览 div）
- [ ] 2-x/3-4 行号校准后 lesson-lint.py 全绿；引用内容零改动（git diff 逐块核对只有行号变化）
- [ ] 新增内容遵守五原则本身（自指合规）
- [ ] 总纲学习日志记录本次增补

**实现记录：**（待填）
