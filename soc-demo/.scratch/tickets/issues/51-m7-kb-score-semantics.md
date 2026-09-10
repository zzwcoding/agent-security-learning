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

**Status:** todo

- [ ] `vector-store.ts:39-40` 注释如实：L2 距离空间、score=1−distance 可为负、仅保证排序单调、不承诺余弦语义（源：lessons/scenario/3-4.md 站 6；教具 S3 实测）
- [ ] 教具 `3-4-kb-demo.mts` 复跑输出与修正后注释口径一致，S1/S2/S4 行为零变化（源：教学布景可复现性）
- [ ] 护栏选项 a/b/c 之一经 L0 裁决落地（本票勾选时注明选择与理由）；选 b/c 时补对应单测（源：本票护栏选项）
- [ ] 既有测试零删除；vector-store 契约测试若锁了 score 字段形态需同步（源：阶段纪律）

## 备注

- 优先级 P3 依据：无安全缺口——INV-5（检索面只有人审过的条目）是承重墙，score 语义只是体验与生产化欠账；教学阶段如实记录不动代码。
- 若选选项 c，注意 R1 的双兼容词表（`known_change‖env_fact`，票 13 stub 与票 17 真件）——校验逻辑需对两类 kind 同构。
