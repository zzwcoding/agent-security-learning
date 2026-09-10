# 51-m7-kb-score-semantics: 检索 score 语义口径修正 + 相关性护栏择一（P3）

**What to build:** 两层：①（必做）修正 `vector-store.ts` 检索得分注释与实现的口径偏差——代码注释写"cosine 相似：越大越近…取 1-distance"，但真 chroma 集合实际建在 **L2 距离空间**（集合配置 `"space":"l2"`），`score = 1 - distance` 可为负（实测 -0.949）。排序语义不受影响（越近 distance 越小、score 越大），但 score 数值不可按余弦解读。②（择一，记票交 L0 裁决）给"命中≠相关"补一道护栏——当前 top-k **无分数门槛**：库条目少时任何查询都"命中"全部条目，而分诊 R1 只看 kind 不看 score（`triage/llm.ts:71`），一条 env_fact 对任何主机告警都会触发"KB 命中→建议关单"。

**缺口解剖（2026-09-10 场景教学 3.4 教具实测发现）：**
- 注释位置：`services/agent/workers/knowledge/vector-store.ts:39-40`（VectorHit.score 的 doc 注释）。
- 实测证据：`lessons/scenario/scripts/3-4-kb-demo.mts` S3——对真容器查 `"量子纠缠态"`（与库内唯一条目零共享词面）仍返回该条目，`score=-0.949`；`"web-01 webshell 攻击取证"` 对 centos7 条目 `score=-0.783`。
- 影响面：排序正确、演示教学语义正确（安全押在 INV-5 入库闸，不在检索精度）；欠的是**可读性**（score 数值语义）与**相关性护栏**（生产化路线）。

**护栏选项（②择一/组合，L0 裁决）：**
- **选项 a（最小）**：仅做①注释修正 + 教具读法保持"score 只用于排序"——不改任何行为。
- **选项 b**：`query` 侧加 score 阈值（低于阈值不返回/或返回但 `below_threshold: true` 标记）——需要定阈值语义（L2 空间下与维度/文本长度相关，建议实测后定）。
- **选项 c**：分诊 R1 加命中条目与告警主体一致性校验（KB 条目 tags/标题含 host 才触发 KB 优先）——挡"一条 env_fact 惠及全宇宙"的误关单，改动在 m4。
- （长期）切换语义 embedding（`KB_EMBEDDING=chroma_default` 注入件已备，需容器出网下模型）——不在本票范围，记票备案。

**Blocked by:** （无）

**Touches modules:** `m7`（+ `m4` 若选选项 c）

**Belongs to spec:** specs/modules.md

**Status:** done

- [x] `vector-store.ts:39-40` 注释如实：L2 距离空间、score=1−distance 可为负、仅保证排序单调、不承诺余弦语义（源：lessons/scenario/3-4.md 站 6；教具 S3 实测）
- [x] 教具 `3-4-kb-demo.mts` 复跑输出与修正后注释口径一致，S1/S2/S4 行为零变化（源：教学布景可复现性）
- [x] 护栏选项 a/b/c 之一经 L0 裁决落地——**选项 a 经 L0 委托裁决落地，理由：P3 零安全缺口、最小修复；b/c 记票留生产化**（b 阈值需 L2 空间实测标定；c 改 m4 行为超出本 P3 最小修复）（源：本票护栏选项）
- [x] 既有测试零删除；vector-store 契约测试若锁了 score 字段形态需同步（实测 contract.test.ts / vector-store.test.ts 均不锁注释口径、锁的是 `1-distance` 变换形态——变换零改动，无需同步）（源：阶段纪律）

## 实现记录（2026-09-10）

**落点**：仅 `services/agent/workers/knowledge/vector-store.ts` 一处注释（`VectorHit.score` doc，原 39-40 行）——零代码改动、零行为变更。

**注释改动前后对照**：
- 改前：`/** 相似度得分（cosine 相似：越大越近；chroma 返回 distance 时取 1-distance）。 */`
- 改后（要点）：检索得分只保证「越大越近」（排序单调），绝对数值不可跨实现互读、不承诺余弦语义；内存件 MemoryVectorStore = L2 归一化向量点积（数学上等价 cosine，[-1,1]）；真 chroma 件集合建在 chroma 默认 L2 距离空间（实测集合配置 `"space":"l2"`，见 3.2），score = 1 − distance **可为负**（3.4 教具 S3 实测 -0.949）；score 只用于排序、无分数门槛——「命中≠相关」（护栏留生产化，记本票）。
- 全文件 grep 复核：`cosine`/`余弦` 口径误导仅此一处，别处无同口径微调必要。

**护栏裁决（选项 a）**：不加阈值、不改 R1、不改任何行为。未采纳理由记票：b（query 侧 score 阈值）需 L2 空间实测标定（阈值语义与维度/文本长度相关）；c（R1 命中条目与告警主体 host 一致性校验）改 m4 分诊行为，超出本 P3 最小修复。二者留生产化路线；长期语义 embedding（`KB_EMBEDDING=chroma_default`）亦照票面备案不在本票。

**验证（全绿）**：
- 定向测试：`pnpm exec vitest run workers/knowledge` → 3 文件 31 用例全过（contract 17 / vector-store 6 / flow 8），零删除；真容器冒烟同场通过（chroma 1.0.0 集合 kb_smoke_*：3 upsert / top-k 检索 / kind 过滤 / 清场）。
- 教具复跑：`pnpm exec tsx ../../lessons/scenario/scripts/3-4-kb-demo.mts`（chroma 可达）→ S3 三查询分值 -0.231 / -0.783 / -0.949，与票面记录逐位一致；S1（hashEmbedding 确定性、异文本余弦 0.0000）、S2（内存 top-k score=0.505）、S4（ChromaKb 命中 env_fact）输出与修正前一致 = 行为零变化。
- typecheck：`pnpm typecheck`（tsc --noEmit）过。

**遗留（备案，不阻塞）**：`vector-store.test.ts:125` 行内注释「1 - cosine distance」仍是被禁改文件内的旧口径（红线只许动 vector-store.ts），实际断言锁的是 `1-distance` 变换形态（distances 0.1/0.6 → score 0.9），变换本身零改动、测试有效；后续如开票动测试文件可顺带改口径。真 chroma 负分值的「命中≠相关」问题在生产化时按 b/c 路线处理（本票记票）。

## 备注

- 优先级 P3 依据：无安全缺口——INV-5（检索面只有人审过的条目）是承重墙，score 语义只是体验与生产化欠账；教学阶段如实记录不动代码。
- 若选选项 c，注意 R1 的双兼容词表（`known_change‖env_fact`，票 13 stub 与票 17 真件）——校验逻辑需对两类 kind 同构。
