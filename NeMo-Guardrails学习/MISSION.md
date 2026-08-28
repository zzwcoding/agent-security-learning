# MISSION: NeMo Guardrails 五种 rail 精读 + 最小实践(issues/07 阶段 18)

**一句话目标**:搞清 NeMo Guardrails 五种 rail 各自挂在 LLM 调用链的哪个位置、怎么判定、怎么配置,并用最小实践实测 self-check rail 打我们语料 01 的两条 payload,回答"对照 starter-agent 三层 llm-guard 护栏的已知缺口,NeMo 能补什么"。

**为什么学**:我们现有的三层护栏全是 llm-guard 分类器(deberta)路线,已暴露"格式伪装注入漏判"这类分类器固有缺口。NeMo 是另一条路线——LLM 自检提示词 + 声明式编排。不亲手跑一遍、不用同一批 payload 对打,就说不清两条路线的取舍。

**验收标准**:
1. lessons/ 下五种 rail 讲清:触发点位置、典型用途、配置方式;重点讲透 LLM 自检 vs deberta 分类器的取舍 + 一条消息的五 rail 完整时序图;Colang 只读轮廓
2. 最小实践跑通:纯 YAML 的 self-check input/output rail,拿语料 01 的"自然请求套 key"和"卡通 SYSTEM OVERRIDE"实测,产出 payload × rail 结果表(含延迟/额外 LLM 调用次数)
3. 对照结论文档:五种 rail × 三层护栏 × 三缺口(格式伪装漏判 / 记忆装载无校验 / write_file 参数侧无扫描),逐个标"能补/不能补/为什么"

**约束**:
- 最小实践不建 agent(无工具、无 LangGraph),`chat.py` 薄壳即可;payload B(touch PWNED)依赖工具,不进本任务
- LLM key 走 `agent-key minimax` 从 Keychain 取,启动脚本注入,不硬编码
- 环境:`uv venv --python 3.12`(nemoguardrails 0.23.0 要求 >=3.10,<3.14,系统 Python 3.14 不可用)
- 节奏:用户说"下一步"才推进,说"提交"才 commit

**阶段路线**(2026-08-28 确认):

| 阶段 | 内容 | 状态 |
|---|---|---|
| 0 | 开工:目录 + 状态文件 | ✅ 已完成 |
| 1 | 裸跑基线:venv + nemoguardrails + 无 rail 最小 config + chat.py | ✅ 已完成(a0e5b8d) |
| 2 | self-check input rail(纯 YAML),语料 01 两条 payload 实测 | ✅ 已完成待提交(两条全拦,对照无误伤) |
| 3 | self-check output rail,构造"输入合法输出泄密钥"场景 | ✅ 已完成待提交(默认清单漏密钥;补条款即拦;推理模型 max_tokens 误拦已记) |
| 4 | 精读 dialog/retrieval/execution 三 rail + 五 rail 时序图;Colang 轮廓 | ✅ 已完成待提交(0.23 双引擎发现:tool rails 只查结构不查语义) |
| 5 | 账单与对照:延迟/token 代价实测,payload × rail 结果表 | 待做 |
| 6 | 收官:五种 rail vs 三层护栏 × 三缺口对照结论文档 | 待做 |
