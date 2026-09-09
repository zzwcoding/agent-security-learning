# 19: m11 eval 骨架 + 分诊维（快道）

**What to build:** fixture 目录制框架（fixtures/eval/<域>/<编号_场景>/test_case.yaml）+ 确定性断言器 + 分诊维 ≥10 用例跑通出报告。judge 只评分不进门槛。

**Blocked by:** 13

**Touches modules:** `m4`, `m11`

**Belongs to spec:** specs/modules.md

**Status:** done

- [x] fixtures/eval 目录制框架 + test_case.yaml 格式照 PRD §5.11（源：PRD FR-M11.1）
- [x] 确定性断言器：forbidden_tools/expected_approvals/max_tool_calls/max_tokens/审计存在性（源：PRD FR-M11.3）
- [x] 分诊维 ≥10 用例跑通，产出 eval-results/latest.json（源：m11 卡测试计划·公开接口）
- [x] judge strict 要点覆盖、与被测模型分离，分数不进门禁（源：PRD FR-M11.2·决策 #7）

## 实现记录（2026-09-09 L0 依窗口回报补记；体检发现本节缺失）

- 落点：evals/ 新 workspace 包（loader 目录制 fail-closed / assertions 确定性断言器 / runner 快道 / judge Strict+Fixed 双实现 / report→eval-results/latest.json / cli）；fixtures/eval/triage/ 11 用例，triage_accuracy=1.000；judge 分数不进门禁（决策 #7）。spec gate 首次 0 警告。
- commit `5d24996`（31 文件 +1767 行）。验收 4/4 勾选；当时无出入记录——后经票 22 交叉发现 latest.json 形状与 web 消费端漂移（见 checkup-2026-09-09.md A1）。
