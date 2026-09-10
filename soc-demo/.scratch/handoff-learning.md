# 学习阶段交接包（soc-demo 场景导览）

```
任务: 按"场景导览"带用户学透 soc-demo 已建成的系统——8 个使用场景 41 步,每步一篇教学文章(函数级调用链+服务中间件选型卡),直至覆盖矩阵 100% + 闯关通过。
角色: L0 总窗口兼讲解人（本阶段不写生产代码,只产教学文章与总纲进度）
模式: 互动档（learn-by-rebuild 场景导览模式）——一次 1-2 步,用户说"下一步"才推进,说"提交"才 commit 教学文章
项目: 仓库根 /Users/divh/Downloads/安全评估agent,项目在子目录 soc-demo/(pnpm workspace;py 服务 guards/gateway;所有命令在 soc-demo/ 下执行)

先读(按序,不要全仓扫读):
1. skill /Users/divh/.agents/skills/learn-by-rebuild/SKILL.md 的「场景导览模式」节(2026-09-09 新增,含专用六节模板与七条模式原则)
2. soc-demo/lessons/scenario/00-导览总纲.md(场景清单 8×41 步/覆盖矩阵/进度——当前进度=场景 1 步 1 未开始)
3. soc-demo/CONTEXT.md(术语+语义核心 INV-1..10,文章的"防线对号"节全靠它)
4. soc-demo/README.md「启动」节(起栈命令,教用户前自己先跑通)

调用: skill learn-by-rebuild(场景导览模式)

产出: soc-demo/lessons/scenario/<场景>-<步>.md(如 1-1.md)每步一篇,六节模板:操作(含位置感)/调用链(函数级,输入→输出→业务逻辑)/服务与中间件卡(≤2 张:自研还是开源、怎么配置、市面替代、本项目为何选、业务上怎么选)/防线对号(INV/契约)/亲手验证(必选,命令+预期特征)/捣乱实验(必选)。每步完成后更新总纲进度勾选与学习日志。

纪律:
- 只读红线: 不改生产代码;走线发现 bug → 记总纲"发现的问题"节转票,不顺手改
- 文章全部落盘,对话只发 3-5 行摘要+路径;跨会话续学先读总纲+git log,不依赖对话记忆
- 用户说"提交"才 commit(git 在仓库根,精确路径 add lessons/scenario/);默认攒着
- 环境事实: Docker daemon 可用;.env 未配真 LLM key 时用 AGENT_LLM=fake 演示(确定性),真网冒烟可选;用户有并行改仓习惯,勿动 deliverables//.claude//.gitignore

验收: 覆盖矩阵全 ✓(总纲内)+每场景 3 道场景题闯关通过+41 篇文章齐全+收官查漏补缺报告
回报: 每步完成后对话回报"场景 X 步 Y 完成,文章在 <路径>,本步踩中 <INV/防线>";每场景收尾给闯关题;全部完成后给收官报告(覆盖率/错题本/遗留)
```

## 开工第一句

用户说"开始导览"或"继续"后：
1. 先按 README 起最小栈（或确认用户已起）：`cp .env.example .env && docker compose up -d --build && bash scripts/setup-openfga.sh`
2. 从总纲第一个未勾步开始（=场景 1 步 1）：先自己把该步的调用链读代码走一遍+把亲手验证/捣乱命令跑通，再写文章落盘
3. 文章写完：对话发摘要+路径 → 用户动手 → 等用户"下一步"

## 当前项目事实速查（写文章时用，别再全仓挖）

- 49 张票全部 done（.scratch/tickets/issues/，每张票内含实现记录/出入——文章写调用链时是最好的佐证材料，按需点名读取，别整目录读）
- 4 份 ADR（复用策略/框架回补/体检裁决/三项终态）——"为什么这么设计"类问题先查 ADR
- 最新全量门禁：agent 482+4sk / web 108 / case-backend 60 / evals 99(33 用例) / ingest 42 / mcp-audit 14 / gateway 43 / guards 26，spec gate 0 警告，boundary 0 越界
- 六幕演示脚本：scripts/web-smoke-21.sh（六幕 curl 等价，可作各场景的"操作"素材库）
