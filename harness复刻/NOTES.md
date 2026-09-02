# NOTES:用户随口提的教学偏好 + 复刻观察(当场记;反复出现的升级进 skill 本体)

- 编号约定:lessons/ 与 learning-records/ 从 0001 起,只在本目录内递增(与主线、9-6 复刻互不干扰)
- commit 前缀 `阶段 45 复刻·N:`,用户说"下一步"推进、说"提交"才 commit
- 参照项目怪点(收官 strip 注释 diff 时核对,复刻不照抄):
  - `evolution.py` 末尾 `generate_synthetic_perturbations`(533-559 行)无人调用、字段名 `tool_name` 与轨迹 schema 的 `tool` 不符,疑为上游遗留死代码
  - `safety_policy_gate.py` 与进化管线互不引用,是独立加固模块——教学上放阶段 12 作三方对照素材
  - `demo.py --generator llm` 走的是旧签名(无 provider/seed),与 run_experiment 的完整路径不同;教学以 run_experiment 为验收入口
