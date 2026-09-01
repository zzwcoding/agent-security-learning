# HANDOFF:路线 2 跨 Agent 迁移交接(2026-08-30 建;2026-09-01 终态刷新:路线 2 全部收官)

> 给换一个 agent 接手用。原始交接(决策、四阶段任务单、验收标准)在 `HANDOFF.md`,本文件只补"当前进度 + 接手 agent 开工所需的增量"。

## 0. 需要移植的 skill

| skill | 位置 | 要不要带 |
|---|---|---|
| **learn-by-rebuild** | `/Users/divh/.agents/skills/learn-by-rebuild/SKILL.md`(单文件) | **必带**——整套教学纪律(小步增量/数据流闭环/注释轮换/讲解落盘/用户控节奏)都在里面 |
| wayfinder | `/Users/divh/.agents/skills/wayfinder/` | 建议带——收官时写票 Answer、维护 map.md 的格式约定 |
| knowledge-cards | 项目级,已在仓库 `.agents/skills/knowledge-cards/` | 不用带,随仓库走 |
| 其他(grilling/research/interview-prep 等) | 用户级 | 路线 2 用不到 |

移植方法:把 `SKILL.md` 内容贴给新 agent 让它照此工作,或复制到对应工具的 skill 目录。

## 1. 当前进度(2026-09-01 终态:路线 2 全部收官)

- **阶段 21–33 全部提交完成,票 09 已写 Answer 关闭**(收官终笔 `8439620`);逐阶段结论见 `MISSION.md` 阶段表(唯一实时真源)。三件交付物在 `deliverables/route2/`(01-边界对比报告/02-劫持无效化验证记录/03-缺口1核销记录),缺口 1 已回写核销 `deliverables/route1/03-已知缺口清单.md`;验收证据 `attack-validation/` 四目录
- **阶段 25 复刻(平行窗口)已收官**:commit `922348d`(12/12 阶段,16/16 gate)+ `02974d9`(lesson 0013 全流程总账);产物在仓库根目录 `自修改agent复刻/`;收官对照 `自修改agent复刻/对照复盘-验证沙箱选型.md` 落定:**候选验证沙箱选一次性 microVM,加固 Docker 降备选**(三候选双后端灯表 100% 一致,probe.sh 双跑数据在案)
- **阶段 30 复刻(另一平行窗口)已收官(2026-09-01)**:11/11 阶段,commit `555a1c7`→`c90302e`;产物 仓库根目录 `日志脱敏复刻/`;收官拍板 `对照复盘-三引擎分工拍板.md`——三出口分工:memory.json=Presidio 保留,Langfuse trace 与本地日志=regex 在线全量 + hybrid 离线补扫(已写入交付物 03 引用)

## 2. 下一步:接路线 3 执行票(票 11,`issues/11-route3-execution.md`,已开出待解)

~~开路线 3 方案票~~ ✅ 已解决(2026-09-01,票 10 Status=resolved):两轮 grilling 拍板 11 条决策——ContextForge 全量收编、OpenFGA 真引入(check 落 tool_pre_invoke 插件)、串联闸留本地中间件(D4+LLM 法官)、审计三面(含自写哈希链锚点)、自写短时令牌、Presidio 预算转投串联闸、供应链体检(mcp-scan 已改名 snyk-agent-scan)、harness-safety-gate 一场全复刻、主体 Py 不动 + TS 裸 SDK 第二消费者。全部决策见票 10 Answer;事实底座 `issues/10-route3-plan/research-contextforge-openfga.md`(部署命令/插件模式/建模示例)。

- 票 11 已开出(open,task):四块任务单(网关收敛+双身份/细粒度授权/串联闸+缺口核销/边界验证+复盘)+ 五条验收 + 约束(编号续排 lessons 0029 起、records 0032 起、阶段 34 起)都在票内
- 开工先读:票 10 Answer + 研究摘要;再按 learn-by-rebuild 纪律切 MISSION 阶段表

## 3. 纪律提醒(沿用)

- 用户说"下一步"才进新阶段,说"提交"才 commit(路线 3 执行期消息前缀 `阶段 N:`;方案票阶段为 wayfinder 常规提交)
- 真 key 只走 Keychain(代理进程经 `scripts/run-proxy.sh` 取;Agent 经 `scripts/run-agent.sh` 零密钥裸启动);`.env` 永远假密钥
- agent 代跑服务:后台任务 + `disable_timeout`;用户自己跑的服务不抢端口
- microsandbox 是 beta:踩坑记 record,不硬撑

## 4. 复制即用开场白

```
读 /Users/divh/Downloads/安全评估agent/.scratch/agent-security-learning/issues/11-route3-execution.md,
按 learn-by-rebuild 的纪律执行路线 3,开工先读票 10 Answer与研究摘要(issues/10-route3-plan/research-contextforge-openfga.md)。
```
