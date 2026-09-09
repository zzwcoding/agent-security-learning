# 48-m9-tool-manifest: ToolManifest 登记机制 + 工具脚手架生成器（ADR 0004-2）

**What to build:** 工具清单落 tools.manifest.json 单一来源（name/tier/family/owner_card/description），verify-ticket 分级改读 manifest（未登记一律 L1 fail-closed 口径保持并写进机制）；契约测试锁 manifest ≡ 各 worker TOOLS 常量 ≡ PRD A.1 清单；`pnpm gen:tool <name>` 脚手架生成「输出一句话」空壳工具 + manifest 行 + 测试骨架，演示新增工具→登记→闸生效 / 未登记被拒全流程。

**Blocked by:** （ADR 0004 已落）

**Touches modules:** `m9`

**Belongs to spec:** specs/modules.md

**Status:** ready-for-agent

- [ ] manifest 单一来源：分级读它；未登记工具默认 L1 被闸（负例测试）（源：FR-S2.1·遗留 G2-4·ADR 0004-2）
- [ ] manifest ≡ TOOLS 常量 ≡ A.1 三方一致性契约测试（漂移必红）（源：体检对账口径）
- [ ] 脚手架生成空壳工具端到端演示：生成→登记→过闸可用；不登记→闸拒（源：用户拍板「新增工具→工具登记，外围用简单空壳」）
- [ ] 既有分级/闸测试零删除（L0 读免验的更严口径如有变化记票）（源：体检口径）
