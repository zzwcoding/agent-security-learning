# MISSION

## 学习目标

用 Python 分阶段复刻 WeKnora 的 RAG + 知识图谱 + Wiki 核心管线，吃透"一份 chunk 如何变成四种知识维度、各维度如何被生产和消费"。学习项目，目的是吃透知识，不是造产品。

## 方法约定（用户已拍板）

- `sdd-flow` 出骨架产物：PRD / CONTEXT.md / modules.md / spec / 票 / CI。
- `learn-by-rebuild` 出执行纪律：小步 ≤30 行、每阶段页面可观察变化、讲解落盘 lessons/、用户说"下一步"才推进、说"提交"才 commit。

## 已拍板决策（2026-09-10，沿用 HANDOFF §3 推荐）

1. **LLM/Embedding 接入**：真实 API 为主（`agent-key <供应商>` 从 Keychain 取）+ fake stub 跑 CI——测试不花钱不抖动。
2. **可观察界面**：Streamlit，阶段 1 起每阶段页面有可观察变化。
3. **存储**：SQLite + numpy 手写向量/图存储（吃透原理），阶段 14 对照真 WeKnora 的 ParadeDB/Neo4j 选型。
4. **示范解析器**：内置 txt/md 解析 + pymupdf（PDF），不复刻 docreader 六引擎。

## 验收标准

- [ ] 14 阶段全部完成且每阶段有页面可观察变化
- [ ] 每阶段 `lessons/NNNN.md` 落盘，用户亲手跑通关键链路
- [ ] 阶段 14 对账报告：完全复刻 / 有意简化 / 真正差距 三栏清楚
- [ ] 每幕收尾 3 道场景题闯关（错题记 NOTES.md）
- [ ] 终极自测：不看资料讲清"一份 PDF 进来怎么变成向量、倒排、图谱、Wiki 四个维度，查询时各自怎么被用"
