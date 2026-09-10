# 0001 · 阶段 1 步 1.1：store 最小切片

- 日期：2026-09-10
- 学了什么：chunk 表 = 唯一事实源（INV-2，书 3.3"索引是可重建的派生物"）；`replace_chunks` 先删后插 = 幂等重建；sqlite3 参数化查询 + `:memory:` 测试库；dataclass 作为全项目词汇表。
- 卡在哪：（暂无）
- 结论：步 1.1 闭合（卡片能落库、能读回），测试 `test_chunk_roundtrip` + `test_reingest_idempotent_chunks` 绿；门禁（spec/boundary/ruff/pytest）全绿。教学落盘 `lessons/0001-入库最小闭环.md`（随阶段推进原地更新）。
- 下一步：步 1.2 ingest 固定 512 分块 + `fixture_2000tokens.txt`。
