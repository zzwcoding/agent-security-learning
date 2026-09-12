# 69-b5-defense-report-lessons: B5 防线压下实验 + 总报告 + 教学文（收官）（P2）

**What to build:** ①防线压下实验三件（压着票 66/67 的负载做）：guards 进程 kill/挂起→闸 fail-closed 断言（工具调用被拒绝而非放行，恢复后行为）；gateway 停→铸票失败路径不留"已批准无票"悬置态断言；SQLite 并发写锤到 busy 超时边界→延迟曲线与错误面观察。每个实验一个脚本（`scripts/bench/b5-*.mjs`）+fail-closed 断言。②总报告：四天花板理论 vs 实测总表+各层拐点汇总（docs/research/2026-09-12-压力测试报告.md 收尾章）。③`lessons/` 教学文一篇："压力也是一种异常：防线在压下"——按 learn-by-rebuild 六节模板，含亲手验证与捣乱实验，术语回指 TERMS。④实验后栈恢复干净（down+data 清空，布景可一键重建）。

**铁律:** 同票 64；实验产生的 PII 用假数据；密钥不进仓库。

**Touches modules:** `m13`、`m9`、`m2`、`m3`

**Belongs to spec:** specs/modules.md（m13 卡）；设计源 docs/research/2026-09-12-压力测试方案.md §三 B5/§四

**Blocked by:** 68

**Status:** done（2026-09-12 子 agent 施工+主窗口验收：B5 三实验 fail-closed 全成立（guards 压下零绕过/gateway 无悬置态/写锤 busy 边界公开面不可达）+ 收尾章四天花板对照 + lessons/50 落盘——bench 链收官）

**验收：**
- [x] 三实验脚本+fail-closed 断言全绿（过载下 INV-1 语义成立）
- [x] 总报告四天花板对照表齐全，拐点结论一句一条
- [x] lessons 教学文落盘（六节模板，比喻用 TERMS 存量体系）
- [x] 实验后布景一键重建验证；全量测试保持绿

**实现记录：**（2026-09-12，票 69 收口，B5/bench 链收官）
- 三实验脚本落 `scripts/bench/`（断言判定器在 `lib/b5.mjs`，纯函数离线单测 15 条先红后绿）：①`b5-guards-kill.mjs`——sustained 2/s 压着，开压 4s 后 `docker kill` guards（选型 kill 钉 unreachable/timeout 出站分支；compose 无 restart 策略实测 RestartPolicy=no），**保持压下态排干（173s）才 docker start**；断言：kill 后创建且窗内执行完的 run 必带 guards_block/DENIED 帧（12 run 人均恰 3 帧=必扫段数），零绕过、零挂死，恢复腿如常。②`b5-gateway-down.mjs`——kb_write 停靠卡 + `docker compose stop gateway`：approve 502 mint_failed、卡 pending/run awaiting_approval/审计零裁决痕迹（「已批准无票」在结构上不存在）；压下期 autorun 拉起 → failed(mint_failed) + FAILURE 强杀审计；复绿重批先吃 1 个死 keep-alive 的可重试 502，重试即成。③`b5-sqlite-hammer.mjs`——只走 REST 写口并发锤（1/4/16/64×10s）：全档零错误、平台 ~1.4-1.5k writes/s、C=64 p99 96ms；busy 5s 边界公开面不可达（M2 单进程单连接写串行，无第二写者）——结论不是失效。
- 首跑教训钉进判定器与单测：**fail-closed 归因看执行时刻**——kill 前创建/跨恢复执行的 run 零 DENIED 帧是合法读数（preKillCreated/crossRecovered 另账）；healthz 绿 ≠ 扫描就绪（guards 冷启动首扫可超时被拒），恢复判定用「healthz 绿+首次真扫描成功」双闸；容器视角 kill=黑洞连接→reason 全 guards_timeout（宿主才是 ECONNREFUSED）。
- 总报告收尾：`## 收尾 · 四天花板理论 vs 实测`（四行理论 vs B1-B5 实测 + guards 外加变量行，拐点结论一句一条；含票 66 带写入水位收缩、票 68 shedding）+ B5 三实验方法/表格/读数节 + 已知边界注记补 8 条 + 复现补 B5 三行。
- lessons 落盘 `lessons/50-压力也是一种异常-防线在压下.md`（50=现有最大号+1；六节模板，比喻全走 TERMS 存量：安检员/保安处/档案室/派活的/手令/留痕）。
- 测试：bench `npm test` 72/72 绿（54 存量 + 18 新增）；全量 `pnpm test` 绿只增不减；双闸 check_specs/check_boundary 全绿；services/** 与 compose 零改动。
- 布景善后（与 64/66/67/68 同款）：down→清 data→默认九服务 up + setup-openfga + replay 12 告警，一键重建验证过。
- L0 验收（主窗口，2026-09-13）：亲跑双闸 PASS + bench 72/72；报告收尾章与 lessons/50 结构核对过（四天花板对照表 5 行含 guards 外加变量、一句一条；教学文 TERMS 回指与"应看到什么"齐）；变更清单 9 文件全落在 bench/报告/lessons/票。收尾五样：spec 无出入（m13 卡接口面 b5 三脚本属"B2-B4 的 autocannon 脚本"同族扩展，L0 已在 m13 Adapter 行同步口径）/ modules.md 已同步（票 68 时一并做）/ CONTEXT 无新术语 / 施工日志=报告 B5 节+收尾章+本记录+lessons/50 / 架构投影无变更。三处断言语义修正（执行时刻归因/恢复双闸/重试语义）均为首跑实测澄清，非范围变更。无遗留标记。**bench 链（阶段 A）至此收官。**
