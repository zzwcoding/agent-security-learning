# MISSION:chapter9/harness-safety-gate 对照复刻(路线 3 阶段 45,平行窗口)

> **状态:⏸️ 暂停于阶段 6/13(2026-09-02)。** 阶段 1-6 已提交(缺陷现场→诊断聚簇→门禁本体→提案打包→静态闸→隔离回放引擎);续作先读 learning-records/0001-0006 与 git log,从阶段 7 开工(见文末"暂停点")。
> 平行窗口:主线窗口做阶段 46 收官组装,本窗口复刻实验 9-7,产物只放 `harness复刻/`。

**一句话目标**:从零复刻"实验 9-7:由用户反馈触发的高风险操作确认门禁",搞懂它的安全骨架——
**用户纠正/点踩/事后审计三类外部反馈聚成失败簇 → Coding Agent 生成 `confirmation_gate.py` 提案
→ 模型外门槛(AST 静态检查 + 内存模拟回放 8 边界 + 7 保留 + token 单次性)全过才 `release_to_canary`;
stable/验证器/JSON 数据是可信根,SHA-256 快照自证未被提案越权改动。**

**为什么学**(区别于"做什么"):主线(票 11)阶段 39 串联闸 + 42 任务票已经实现了我们自己的
"高风险确认"——但那是**规则+LLM 法官自动裁决,无人工**。9-7 反着来:**高风险调用必须人来确认**
(token 单次性)。两条路线的分界线——什么场景必须人来确认、什么场景可以自动裁决——正是
收官对照(必做)要回答的 JD 级设计判断。另与 9-6 复刻对照:9-6 改控制层、信号来自内部错误日志、
要 Docker 沙箱;9-7 改安全/验证层、信号来自外部用户反馈、提案是**新增独立模块**故只需
AST 静态检查+内存回放,无沙箱。

## 验收标准(13 阶段路线,来自 HANDOFF §2 细拆)

| # | 新增什么 | 可观察变化 |
|---|---|---|
| 1 | 缺陷现场:`stable/tool_dispatcher.py`(无风险分级)+ 11 条失败轨迹 + demo 读取 | demo 打印"delete_file 未确认即被执行"的失败轨迹 |
| 2 | 诊断聚簇:classify_risk + diagnose(支持度门槛 2,过滤已确认/低风险反馈) | demo 打印 3 个失败簇;rm -rf 单条不成簇 |
| 3 | 确认门禁本体:confirmation_gate(classify/issue_confirmation/dispatch,一次性绑定 token) | demo:无票挂起 → 签票执行 → 复用票被拒 |
| 4 | 提案打包:candidate_from_gate + 对 dispatcher 的最小接入 diff(仅提案) | demo 打印接入 diff |
| 5 | 静态闸:compile + AST 导入白名单/禁 eval/exec/open + 契约检查 | demo:带 eval 的坏提案被 security_scan 拦下 |
| 6 | 隔离回放引擎:干净命名空间加载 + 注入 executor + 单用例回放 | demo:挂起/拒绝时 executor 零调用 |
| 7 | 全量门槛:boundary 8 条 + retention 7 条 + 单次性检查 → 六项检查汇总 | demo:我们的门禁 6/6 全绿 |
| 8 | 反例必拒:"放行一切"的门禁过同一门槛 | demo 同屏:确定性提案过、反例拒 |
| 9 | 发布决定+manifest:decision/canary_gate/回滚哈希钉在 stable + 落盘 | demo 打印 manifest 关键字段 |
| 10 | 验收入口 --quick:SHA 快照可信根自证 + 11 条验收 gate + 反例先行 | 全绿表 accepted=true |
| 11 | 真实 LLM 路径(Keychain 注入,可选):llm_generator + evidence 回执 | 真模型提案过/拒均属合法结果(被拒=预期安全结果) |
| 12 | 加固版独立门禁(可裁剪):safety_policy_gate(路径穿越/危险命令/资源限制/TTL/回滚) | 27 项测试逐绿 |
| 13 | 收官:与主线串联闸对照 + strip 注释逐文件 diff + 选型分析 | 对照复盘文档 |

## 收官必答(阶段 13 写进复盘,不许和稀泥)

**什么场景必须"人来确认",什么场景可以"自动裁决"?**
三方对照:9-7 确认门(人工,token 单次)/ safety_policy_gate(自动规则+TTL+回滚)/
主线串联闸(D4 规则+LLM 法官+任务票,全自动)。

## 纪律(learn-by-rebuild + HANDOFF §4)

- 每阶段小步可运行、数据流闭环;用户说"下一步"才推进,说"提交"才 commit
- commit 前缀 `阶段 45 复刻·N:`(HANDOFF §4 默认);lessons/learning-records 自编号 0001 起,只在本目录递增
- 参考项目只读勿改:`/Users/divh/Downloads/深入理解agent 实验/ai-agent-book/chapter9/harness-safety-gate/`
- microsandbox/网关等主线服务与本窗口无关,勿动;离线优先,pytest+demo 全程不需要 API Key

## 暂停点(2026-09-02,续作从这里接)

- **代码现状**:demo.py 长至阶段 6 段;evolution.py 已有诊断聚簇/提案打包/静态闸(_safe_ast+validate_candidate 前三项)/隔离回放引擎(_load_gate/_check_contract/_make_executor/_replay_case,STABLE 按路径加载);confirmation_gate.py 手写原型可跑;**validate_candidate 的签名目前只收 source,boundary/retention 两参在阶段 7 再扩**。
- **下一步 = 阶段 7(全量门槛)**:从参照项目复制 `boundary_cases.json`(8 条)+ `retention_cases.json`(7 条,可信根数据,照抄不改动);evolution.py 补 `_check_single_use` + `_replay_all`,validate_candidate 收齐后三项;demo 打印六项检查全绿。
- **再往后**:阶段 8 反例("放行一切"的 REJECTED 版过同一门槛必拒)→ 9 发布决定+release_manifest(此时给 diagnose 补 change_contract,阶段 2 埋的最后一个 deferred)→ 10 验收入口 `--quick`(SHA 快照+11 条验收 gate)→ 11 真 LLM(可选,Keychain minimax)→ 12 加固版 safety_policy_gate(可裁剪,27 测试)→ 13 收官对照。
- **收官勿忘**:必答"什么场景必须人来确认 vs 可自动裁决"(HANDOFF §3,三方对照:9-7 确认门 / safety_policy_gate / 主线串联闸+任务票);strip 注释逐文件 diff 时核对 NOTES.md 里记的三处参照项目怪点与两处有意改进(门禁独立成文件、demo 为教学入口)。
- **编号现状**:lessons/ 与 learning-records/ 已至 0006;commit 前缀 `阶段 45 复刻·N:` 已用至 6。
