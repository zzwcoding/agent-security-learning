# 49-01 · PII mapstore 落地与受控反查口：脱敏之后，原文去哪了

> 票 49（ADR 0004 裁决 3，本波最后一张）的教学文档。读前需要知道：guards 的
> Presidio 脱敏（票 24）把手机号换成 `<PHONE_NUMBER>` 这种占位符再放行——但替换掉的
> 原文直接扔掉了，谁也找不回来。这一票回答的问题是：**万一值班长需要知道这个占位符
> 底下是什么，怎么"有规矩地"找回来？**

## 一、三问（这一票是干嘛的）

**位置感先行**——阶段 7 收官三项裁决的最后一项（ADR 0004 拆成票 47/48/49）：

```
票 47：run 异步化（POST 秒回 + 分发循环 + 审批卡保质期）
   ✅
票 48：ToolManifest 登记机制 + 工具脚手架生成器
   ✅
票 49：PII mapstore + 受控反查口
   ↑ 你在这里（本波收官）
```

- **这一票是干嘛的？** 两件事。其一，脱敏时把「占位符→原文」的对照表记下来，
  落到 guards 自己的 SQLite 文件里（重启不丢）——这本对照表就是 **mapstore**。
  其二，给这本对照表配一个"有规矩的查阅窗口"：web 页面上值班长/管理员能点
  「反查」按钮 → agent 的端点验身份、看角色、记审计 → 转发到 guards 拿回原文。
- **什么需求逼我们这么设计？** PRD 里有句自相矛盾的旧账（FR-S4.2）：早期说映射表
  "会话级内存、run 结束即弃"——等于设计了却不让找回（票 24 记过：实现里压根没有
  这个东西，投影图上是个"幽灵节点"）。L0 拍板（ADR 0004 裁决 3）：**做了映射就配
  一个受控反查口**——没人反查就做一个反查入口。但反查 PII 是危险动作（查一次就等于
  看一次别人身份证），所以必须"受控"：谁能查、查了什么、什么时候查的，全都要有据可查。
- **解决了什么麻烦？** 三个：①脱敏不再是"有去无回"的单向门，误脱敏/调查需要时
  能合规地反查；②反查这个动作本身被套进缰绳——角色白名单 + 每查必审计；③划清了
  一条敏感面红线：**原文只活在库里和"授权查询的响应"里，别的任何地方（日志/审计
  详情/事件流）都不许出现**——审计知道"你查了 `<PHONE_NUMBER>`"，但不知道"你查回了
  13812345678"。

## 二、全链路一览

```
【写半边】脱敏时顺手记账（谁生产：guards 的 Presidio 管道）
services/agent/workers/* ──出域前──▶ guards POST /pii/anonymize
                                        │  AnalyzerEngine 找出实体 span
                                        │  ① 按 span 切原文 → record() 进库（票 49 新增）
                                        ▼  ② AnonymizerEngine 替换成 <TYPE>（票 24 原样）
                              sqlite: data/pii-mapstore.sqlite
                              表 pii_map(占位符, 原文, 类型, 首见时间)
                              （compose 挂 ./data/guards 卷 → 重启不丢）

【读半边】受控反查（谁消费：duty_lead/admin 这两个"人"）
web 案件页（检测到 <TYPE> 占位符 + 角色对 → 才出按钮）
   │  POST /api/v1/pii/reveal  带 Bearer 会话
   ▼
agent（services/agent/src/app.ts 新端点）
   │  ① 会话验签（JWT 语义，过期 401）
   │  ② 角色白名单 {duty_lead, admin}（soc1/redteam → 403 + DENIED 审计）
   │  ③ 每查必审计：谁、查了哪个占位符、命中几条（INV-8）
   ▼  guards-client.revealPii（HTTP 出站，超时/不可达 fail-closed）
guards POST /pii/reveal → 查 pii_map → {"originals": [...]}
   ▼
agent 把原文原样回给发起人（响应体是原文唯一合法的出现位置）
```

## 三、跟着数据走 4 步（一条手机号的脱敏与反查）

1. **脱敏（写账）**：文本 `请联系 张三 13812345678` 进 guards。Presidio 的
   AnalyzerEngine 说"位置 7~18 有个 PHONE_NUMBER"。`pii.py` 现在在这时多做一步：
   **替换之前**先切下原文 `13812345678`，和占位符 `<PHONE_NUMBER>` 配成一对写进
   sqlite（重复对幂等，写不重）。然后才让 AnonymizerEngine 干替换的老活——出域文本
   变成 `请联系 张三 <PHONE_NUMBER>`。**响应形状一尘不动**（还是 `{text, entities}`，
   票 32 的形状锁精神）：记账是旁路，不能改变脱敏本身的契约。
2. **重启不丢（验收 1）**：`docker compose restart guards` 之后再反查，原文还在。
   靠的不是运气，是两件装配活：库文件缺省落在进程工作目录的 `data/` 下，而 compose
   给 guards 挂了 `./data/guards:/app/data` 卷（票 41 的 agent 卷同款口径——**挂
   别处等于没挂**）。真容器冒烟实测：restart → reveal → 原文照回。
3. **反查（读账，走的正门）**：值班长在案件页看到时间线里有一条
   `告警涉及邮箱 <EMAIL_ADDRESS>…`。web 检测到占位符 + 她的角色在名单里 → 出
   「反查 PII」按钮。点击后链路是：`POST /api/v1/pii/reveal`（带登录会话）→ agent
   验签、对角色、**先记一笔审计**再转发 → guards 查表 → 原文顺着原路回来，就地在
   条目下方渲染 `<EMAIL_ADDRESS> → zhangsan@example.com`。
4. **捣乱实验——SOC1 想偷看**：SOC1 分析师登录（角色不在名单），按钮根本不出现
   （可见性即第一收窄）。他不死心，直接 curl 端点：agent 验签通过（他是合法用户），
   但角色白名单把他拦下 → `403 pii_reveal_forbidden`，**而且这次被拒的查询自己也进
   了审计**（result=DENIED，actor=soc1）——"每查必审计"包括没查成的。这就是全票
   最重要的一条纪律：成功的查询和失败的窥探，留的是同一本账。

## 四、新技术点：没有新库，只有三个值钱的模式

本票零新依赖（Python 标准库 sqlite3；TS 侧一个 fetch）。值钱的是模式：

- **模式一：有状态收窄进一个"仓库"节点（无状态服务的例外怎么摆）**。guards 全程
  无状态微服务，现在多了一本账——处理办法不是"服务变有状态"，而是把状态**收敛到
  单独一个模块**（pii_store.py，单例连接 + 两个方法 record/reveal），其余管线照旧
  无状态。哪天要换 Redis/Postgres，只动这一个文件。
- **模式二：环境变量覆盖 + 重置接缝（TS 侧 TOOLS_MANIFEST_FILE 的 Python 对位）**。
  `PII_MAPSTORE_PATH` env 覆盖库路径，`reset_store()` 关旧连清指针。测试里它一人
  分饰两角：autouse fixture 把每条用例指到独立 tmp 文件（互不串味）；`reset_store()`
  按同一路径重开 = **"重启"的进程内等价物**——"重启不丢"这条验收不需要真起两个进程
  也能测（真重启另有容器冒烟背书）。
- **模式三：敏感面的"金丝雀式断言"（INV-4 的类推）**。INV-4 管凭证：全链路 grep
  不到 SECRETS_ 值。本票把它类推到 PII 原文：测试把三路审计条目（成功/被拒/失败）
  全部 `JSON.stringify` 后 `expect(dump).not.toContain("13812345678")`——原文可以
  在哪、不可以在哪，边界用一条机器断言钉死，不靠自觉。

## 五、关键顿悟 3 条

- **反查是"人"的动作，不是"工具"调用——所以它不走工具闸**。A.2 四族矩阵
  （readonly_query/case_write/kb_write/incident_response）装不下"PII 反查"：
  它不是 LLM 的工具（任何票面 allowedTools 里都没有它），是操作员在页面上的动作。
  硬塞进工具闸反而错了对象。落法：**端点级角色白名单**（登录会话 + duty_lead/admin），
  矩阵一字不动。边界判断先问"这是谁的动作"，再选闸——此归属已记票交 L0 追认。
- **审计记"查询"这个动作，不记"查到"的内容**。反查审计的五要素是：谁（actor）、
  查了哪个占位符（objectId=`<PHONE_NUMBER>`）、何时、结果如何（SUCCESS/ Denied）、
  命中几条（details.match_count）。原文永远不进 details——**审计要能回答"谁看过
  敏感数据"，不能自己变成敏感数据的第二次泄露源**。
- **"重启不丢"是装配出来的，不是代码写出来的**。sqlite 落盘代码本身不保证重启
  不丢——容器重建后写进容器层的文件直接蒸发。真正起作用的是 compose 那一行卷挂载
  `./data/guards:/app/data`，而且必须挂在**代码解析出的那个路径**上（票 41 的教训：
  挂 /data 等于没挂）。验收 1 的完整证据链 = 单测（重开库不丢）+ compose 装配 +
  真容器 restart 冒烟。

## 六、亲手验证

```bash
cd /Users/divh/Downloads/安全评估agent/soc-demo

# ① 起真容器，脱敏一条带手机号和邮箱的文本
docker compose up -d guards && sleep 8
curl -s -X POST http://127.0.0.1:8001/pii/anonymize \
  -H 'content-type: application/json' \
  -d '{"text":"联系 张三 13812345678，邮箱 zhangsan@example.com","language":"zh"}'
#    应看到：text 里两个占位符（<PHONE_NUMBER>/<EMAIL_ADDRESS>），原文消失

# ② 反查：占位符 → 原文回来了
curl -s -X POST http://127.0.0.1:8001/pii/reveal \
  -H 'content-type: application/json' -d '{"placeholder":"<PHONE_NUMBER>"}'
#    应看到：{"placeholder":"<PHONE_NUMBER>","originals":["13812345678"],"count":1}

# ③ 重启不丢（验收 1 的现场版）
docker compose restart guards && sleep 8
curl -s -X POST http://127.0.0.1:8001/pii/reveal \
  -H 'content-type: application/json' -d '{"placeholder":"<PHONE_NUMBER>"}'
#    应看到：原文还在。宿主机 data/guards/pii-mapstore.sqlite 就是那本账

# ④ 捣乱实验：查一个不存在的占位符
curl -s -X POST http://127.0.0.1:8001/pii/reveal \
  -H 'content-type: application/json' -d '{"placeholder":"<NO_SUCH>"}'
#    应看到：{"error":"placeholder_unknown"}（404，一视同仁不透露库里有什么）

# ⑤ 端到端角色闸（需要最小栈：case-backend + agent + guards + SOC_HMAC_KEY）
TOKEN=$(curl -s -X POST http://127.0.0.1:3003/api/v1/auth/login \
  -H 'content-type: application/json' -d '{"username":"soc1@soc.local"}' | python3 -c 'import json,sys;print(json.load(sys.stdin)["token"])')
curl -s -X POST http://127.0.0.1:3003/api/v1/pii/reveal \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"placeholder":"<PHONE_NUMBER>"}'
#    应看到：403 {"error":"pii_reveal_forbidden"}；换 duty_lead@soc.local 登录重试 → 200 原文
#    再查 GET /api/v1/audit：两条 pii_reveal，soc1 那条 result=DENIED，details 里没有原文

# ⑥ web 端：duty_lead 登录 → 案件时间线里含 <TYPE> 的条目旁有「反查 PII」按钮，
#    点击就地显示 `<EMAIL_ADDRESS> → 原文`；换 soc1 登录同一页面 → 按钮不出现

# ⑦ 测试三连（guards 需 venv：.venv/bin/python）
cd services/guards && ../../.venv/bin/python -m pytest -q          # 26 passed
cd ../agent && pnpm exec vitest run src/pii-reveal.test.ts         # 8 passed
cd ../web && pnpm exec vitest run src/reveal.test.ts               # 6 passed
```
