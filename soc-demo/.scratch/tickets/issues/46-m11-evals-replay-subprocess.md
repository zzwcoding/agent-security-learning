# 46: evals replay rig 改子进程执行（边界盲区收口）

**What to build:** evals/src/rigs/replay.ts 直引 ../../../scripts/replay.js（自票 44 前 scenarios.ts 逐字搬移，落在 R2/R4 规则之间的盲区）。照票 28 E3 同款口径改子进程执行（execFile tsx scripts/replay.ts + 解析 stdout 行为面），并把边界规则表 R4 的禁令范围扩到 evals（措辞："services/、evals/ 测试与 rig 反引仓库级 scripts/ 禁止，replay 类走子进程"）。行为零变化：replay 两用例（同 fixture 双推去重/整目录双遍）断言语义逐条保持。

**Blocked by:** （无）

**Touches modules:** `m11`

**Belongs to spec:** specs/modules.md

**Status:** done

- [x] rigs/replay.ts 零 scripts import，replay 两用例语义保持（源：收尾体检对账二-7·票 28 E3 同款）
- [x] 边界规则表 R4 措辞扩 evals，check_boundary.py self-test 补该向红样本（源：核心原则 7）
- [x] 全仓门禁绿，测试零删除（源：体检口径）
