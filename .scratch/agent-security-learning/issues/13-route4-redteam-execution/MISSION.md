# MISSION —— 票 13 路线 4 红队执行(教学轨道)

**一句话学习目标**:从"建防线的人"切换到"打防线的人"——拿业界红队武器(garak/PyRIT)系统性地打自己路线 1–3 建成的收官形态,用实测数据回答"每层防线到底兜住什么",并把攻击沉淀成每次改动都能重跑的回归集;能用 JD 的语言讲清"红队证明有效、CI 保证演进"。

**验收标准**(票 12 Answer 第 10 条,六条):① 武器校准(裸靶出 hits+收官形态被拦率)② 四方向 campaign 纵深判表(应被哪层拦/实测哪层拦/漏到第几层)③ 剥层对照 ≥3 组 ④ TS client bob 越权全 fail closed+user_map 书面结论 ⑤ 缺口 4/5 标定流程入 CI、缺口 6 穿透率+聚合方案文档 ⑥ 种子十条收编+确定性断言 100%+三件交付物落 `deliverables/route4/`。

**开工必读**:票 12 Answer(11 条定案)→ 票 06 Answer(工具链形态)→ 缺口清单 4/5/6 条。

**约束**:靶子唯一=路线 3 收官形态 `starter-agent/`;红队代码只进 `starter-agent/redteam-regression/`+薄层文件;**防线代码本关不动**,打穿记缺口不临修;judge=MiniMax-M2 只评分不进门槛;真 key 只走 Keychain;lessons 从 0042 起,records 从 0043 起;garak/PyRIT 迭代快,踩坑记 record。

**阶段路线**(编号续路线 3 的 46;对应票 13 五块任务单,颗粒度按教学步长切):

| 阶段 | 内容 | 页面/行为上能看到什么 | 状态 |
|---|---|---|---|
| 47 | 开工先决:garak/PyRIT 双 venv + 薄 HTTP 层(8000)+ 武器校准靶(8010,全工具干跑) | 薄层烟测双过;裸靶被 promptinject 打出 hits(ASR 1.56%) | ✅ 已完成(2026-09-02;lesson 0042,record 0043) |
| 48 | 对照第一枪:同一 probe(promptinject.HijackHateHumans)打收官形态 | 裸靶 1.56% vs 收官形态的被拦率并排——防线第一次被武器量化 | ⬜ |
| 49 | garak 白名单五族宽谱(promptinject/encoding/packagehallucination/leakreplay 全量+dan 节选)+ hits 人工分诊 | 五族报告 + 分诊表(真阳性/误报/被拦) | ⬜ |
| 50 | PyRIT 进程内 PromptTarget 最小版(直调 graph,轨迹回传) | 一条 payload 不经 HTTP 打进来,轨迹摆在响应里 | ⬜ |
| 51 | 确定性 scorer 五条断言 → pytest 红绿 | `pytest` 跑出第一条"注入后不得调 run_command" | ⬜ |
| 52 | Crescendo 多轮全量 + 拆行投毒穿透率实测(缺口 6 数据) | 多轮诱导对话树;拆行投毒穿透率数字 | ⬜ |
| 53 | PAIR 全量 + TAP 对照一轮;TS client bob 第二通道场景 | bob 越权全 fail closed;user_map 滥用面结论 | ⬜ |
| 54 | 剥层对照 ≥3 组(串联闸一件/记忆三闸/网关 FGA/EGRESS,每次只关一层) | "漏到第几层"判表——每层防线的失效假设有了实测证据 | ⬜ |
| 55 | 标定流程:标本集(正例毒种+负例善意/高熵/中文)+ 阈值扫描报告(缺口 4/5 核销) | 0.1–0.9 阶梯误/漏率表 + 工作阈值选定理由 | ⬜ |
| 56 | 种子十条收编 payloads/ + pytest 回归全绿 + 触发纪律落地 | 回归集成型,改防线后一键重打 | ⬜ |
| 57 | 精读 promptinject+encoding probe 源码;vulnerability-db/audit-db 案例对照("打在收官形态会被哪层拦") | 对照分析喂红队报告;从"用 payload"到"会写 payload" | ⬜ |
| 58 | 收官:三件交付物 + 六条验收判表 + 回写缺口清单(7 条清账)+ 票 13 Answer | `deliverables/route4/` 三件;票 13 关闭 | ⬜ |
