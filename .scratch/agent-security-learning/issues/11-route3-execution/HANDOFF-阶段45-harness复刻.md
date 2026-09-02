# HANDOFF:harness-safety-gate 平行复刻交接(阶段 45 开工包,2026-09-02)

> **状态(2026-09-02)**:复刻已进行到 **6/13 阶段后暂停(用户决定不续)**,commit `b1ef0c3`。续作上下文全在仓库根目录 `harness复刻/MISSION.md` 暂停点(阶段 7:复制 boundary/retention JSON + 收齐六项检查;8-13 清单;收官必答"何时必须人来确认 vs 可自动裁决")。新窗口开工读 `harness复刻/MISSION.md` + `harness复刻/learning-records/` + git log 即可接上。主线收官(阶段 46)不受影响。

> 给平行窗口:按 learn-by-rebuild 纪律复刻 `ai-agent-book/chapter9/harness-safety-gate/`(实验 9-7:由用户反馈触发的高风险操作确认门禁)。与主线窗口(阶段 46 收官组装)并行,产物放**仓库根目录 `harness复刻/`**(用户指定根目录惯例,参照 `自修改agent复刻/`、`日志脱敏复刻/`)。

## 0. 必读上下文(按序)

1. `/Users/divh/.agents/skills/learn-by-rebuild/SKILL.md` —— 教学纪律(小步增量/数据流闭环/讲解落盘/用户控节奏,"提交/下一步")
2. 参照项目:`/Users/divh/Downloads/深入理解agent 实验/ai-agent-book/chapter9/harness-safety-gate/`(README 极详,先读)
3. 姊妹实验经验:`自修改agent复刻/`(实验 9-6,同为"反馈驱动的 Harness 自进化",12 阶段/16 gate 的复刻结构可直接参考——但 9-7 **不需要 Docker 沙箱**,提案是新增独立模块而非覆盖补丁,验证=AST 静态检查+内存模拟回放)
4. 主线对照:`.scratch/agent-security-learning/issues/11-route3-execution/lessons/0034-串联闸-D4规则与LLM法官.md`(我们自己的"高风险确认"实现,复刻收官时必做对照)

## 1. 参照项目的核心(一段话)

用户纠正/点踩/事后审计三类反馈指向同一缺陷:`delete_file`、`git_push(force=True)`、`DROP TABLE` 等不可逆调用未经确认就执行。系统让 Coding Agent 生成 `confirmation_gate.py` 提案(高风险调用须确认),经**模型外门槛**后灰度:AST 白名单扫描(禁 eval/exec/open)→ 隔离回放(假 FS/Git/DB,boundary 8 条+retention 7 条+token 单次性)→ 全过才 `release_to_canary`。发布清单含 SHA-256 快照,证明 Agent 没越权改可信根。官方已验证:真 LLM(gpt-4o-mini)提案被门槛拒绝属预期安全结果;确定性提案过、放行一切的反例被拒。

## 2. 复刻范围与阶段建议(草案,窗口内按教学步长细拆)

- 参照量级:9-6 复刻用了 12 阶段;本项目核心文件更小(safety_policy_gate.py 438 行,另有 evolution.py/llm_generator.py/两个测试文件+三份 JSON 数据)
- 主线骨架(从 README/测试反推):① dispatcher+高风险工具表 → ② 确认 token 机制(签发/绑定工具名+完整参数/单次性)→ ③ 三类反馈信号采集 → ④ 提案生成(确定性版先行)→ ⑤ AST 静态检查 → ⑥ 隔离回放环境(假 FS/Git/DB)→ ⑦ boundary/retention 回放门槛 → ⑧ 反例(放行一切的门禁)必拒 → ⑨ release/reject 决策+发布清单(SHA 快照)→ ⑩ 真实 LLM 路径(可选,Keychain 有 minimax)→ 收官对照复盘
- **离线优先**:pytest + demo + `--quick` 全程不需要 API Key;真 LLM 路径作可选收尾

## 3. 收官必做:与主线串联闸的对照(写进复盘文档)

| 对照点 | 参照(9-7 confirmation_gate) | 主线(阶段 39 串联闸+42 任务票) |
|---|---|---|
| 触发方式 | 高风险调用须**人工确认**(token 单次性) | 任务票 scope+D4+LLM 法官,**自动裁决** |
| 谁来批准 | 用户(交互) | 规则+法官(无人工) |
| 信任根 | gate 模块是可信根,提案不可越权改 | 中间件在 Agent 进程内,进程被破则失守 |

对照结论应回答:**什么场景必须"人来确认",什么场景可以"自动裁决"**——这是两条路线(确认门 vs 自动闸)的分界线,也是 JD 级设计判断。

## 4. 纪律(沿用)

- 用户说"下一步"推进、说"提交"才 commit(消息前缀 `阶段 45 复刻·N:` 或窗口自编号)
- lessons/learning-records 自编号 0001 起,放 `harness复刻/`
- microsandbox/网关等主线服务与本窗口无关,勿动
