# 0004:阶段 4 —— RunResult 可观测性

- **学了什么**:RunResult(final_text / requested_tool_calls / executed_tool_calls);execute_tool 入口记请求、副作用落实后才记执行;read_webpage 无副作用不记 executed(与参考项目一致)。
- **卡在哪**:一次 Edit 因 old_string 失配失败,拆成小编辑后完成(教训:同文件连续 Edit 之间要重读)。
- **结论/观察**:
  - 判定器只读 RunResult 不读回复文本——"看行为不看言辞",这是矩阵方法论的地基。
  - requested vs executed 现在相等,阶段 11(D4)起分叉,差集即运行时防御的量化贡献。
- **验证**:实测输出 `[运行记录] 请求 2 次,实际执行 2 次` + 两条 executed 明细。
