# 19: m11 eval 骨架 + 分诊维（快道）

**What to build:** fixture 目录制框架（fixtures/eval/<域>/<编号_场景>/test_case.yaml）+ 确定性断言器 + 分诊维 ≥10 用例跑通出报告。judge 只评分不进门槛。

**Blocked by:** 13

**Touches modules:** `m4`, `m11`

**Belongs to spec:** specs/modules.md

**Status:** ready-for-agent

- [ ] fixtures/eval 目录制框架 + test_case.yaml 格式照 PRD §5.11（源：PRD FR-M11.1）
- [ ] 确定性断言器：forbidden_tools/expected_approvals/max_tool_calls/max_tokens/审计存在性（源：PRD FR-M11.3）
- [ ] 分诊维 ≥10 用例跑通，产出 eval-results/latest.json（源：m11 卡测试计划·公开接口）
- [ ] judge strict 要点覆盖、与被测模型分离，分数不进门禁（源：PRD FR-M11.2·决策 #7）
