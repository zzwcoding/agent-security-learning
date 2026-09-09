# 21-01 · 票 21：m10 Web 下——审批卡、案件时间线、Eval 页，六页面锁死

## 三问

**位置感**：玻璃窗的上半扇（登录/告警/流水线/审计）票 20 已经装好。这一票把剩下
半扇装上，然后——这是本票真正的主题——**把窗户焊死**：

```
票03 m2 ✅ → 票04-12 门与闸 ✅ → 票10/11/13-17 编排+worker ✅ → 票18 对话 ✅ → 票19/23/24/26/27 件 ✅
→ 票20 Web 上半 ✅ → 票21 Web 下半 ✅你在这里（审批卡/时间线/Eval + 范围锁死）
→ 后面：票22 eval 全维 → 收官
```

- **这一步是干嘛的？** 三个新页面：审批卡（值班长批准/驳回 L2 动作，409 并发兜底）、
  案件时间线（详情 + 时间线 + 对话追问入口）、Eval 结果（最近一次跑分三维展示）。
  外加一条铁规矩的机器化：**六页面之外无任何路由**（决策 #6）。
- **什么需求逼我们这么设计？** m10 卡的验收标准原文："六幕演示剧本全部可在 Web
  完成且每幕同步有 curl 等价脚本；六页面之外无任何路由（范围锁死）"。麻烦是：
  前端项目的路由表是最容易"顺手加一个"的地方——加着加着演示窗就长成了管理后台。
  所以范围锁死不能靠自觉，得靠**机器断言**：路由表写成一个 6 行的常量，测试文件
  盯着它 deep-equal，谁加一行谁红。
- **解决什么麻烦？** 三个：① 审批是「人在回路上」的最后一环，之前只有 curl 能裁决，
  演示现场没法让值班长点按钮；② 案件的时间线散在两处（M2 的 timeline_entries +
  agent 的审批卡），需要一个页面把它们拼成一条故事线，还要能顺手追问；③ Eval
  产物 `latest.json` 躺在磁盘上，页面得有个不越权的拿法。

## 全链路一览

```
浏览器（一切请求同源相对路径，vite dev :5173 按前缀分叉转发）
   │ ①审批卡页    GET  /api/v1/approvals?status=pending      ──代理→ agent :3003
   │              POST /api/v1/approvals/:id/approve|reject     （批准铸 ApprovalToken→resume）
   │              并发后到者 → 409 InvalidTransition（审批状态机 INV-10 仲裁）
   │ ②案件时间线  GET  /api/v1/cases/:id（详情+timeline）   ──代理→ case-backend :3002
   │              GET  /api/v1/approvals（case_id 对上号的卡）──代理→ agent
   │              timeline.ts 把两路拼成一条时间线（按时间排序）
   │ ③追问入口    POST /api/v1/chat {message, case_id}      ──代理→ agent（票 18 正门）
   │              Bearer 会话；SSE 帧 token/denied/… 用 fetch 流式读（不重用 EventSource）
   │ ④Eval 结果   GET  /eval-results/latest.json            ──vite 静态面（磁盘原样）
   ▼
页面只做三件事：调 API、渲染、把「装配合并」写成纯函数（单测盯得住）
```

## 跟着数据走：一张审批卡的一生（真栈冒烟实录）

布景：本机最小栈（lessons/20-01「亲手验证」同款五服务 + vite dev），
agent 以 `AGENT_LLM=fake` 起跑，离线确定性。

1. **开卡**：值班长在时间线页的追问抽屉里输入「隔离主机 centos7」→ 浏览器
   `POST /api/v1/chat`（Bearer 会话 + case_id）→ 后端意图闸判 `require_approval` →
   聊天流里先吐一句"已提交审批卡"的 token，随后 `approval_required` 帧。
2. **看卡**：切到审批卡页，2 秒轮询的 `GET /api/v1/approvals` 拉回这张卡：
   `tool=isolate_host`、`params={host:"centos7"}`、`status=pending`。
   注意页面**没有**任何"代为执行"的按钮——批准只递交决定，执行的唯一依据是
   后端为这张卡铸的一次性 ApprovalToken（INV-9：验签不信文本）。
3. **驳回（故意先驳回）**：点「驳回」填缘由 → `POST /api/v1/approvals/:id/reject` →
   响应里 `run_status: completed`（run 被 resume，动作节点拿到 rejected 跳过执行）。
   卡片翻成「已驳回」红色 Tag——这就是"实时反馈"：裁决响应即时提示 + 轮询把
   卡面/执行标记刷回来。
4. **手慢了（409）**：对着同一张已裁决的卡再发一次裁决 → 后端审批状态机
   （pending 之外无路可走，INV-10）回 **409 InvalidTransition**。页面的
   `decideErrorText` 把它翻译成人话："手慢了：这张审批卡刚被别人裁决过
   （并发后到者 409），列表已刷新"——这是正常剧情，不是报错弹窗。
5. **重来并批准**：再追问一次开新卡 → 点「批准」→ 响应带 `approval_token` 字段
   （形态可见，页面不存它）+ `run_status: completed`；轮询回来卡上多一枚
   「已执行」Tag（`executed_at` 落库 = token 已验签焚毁，重放必 403）。
6. **落进时间线**：回到案件时间线页——审批卡的批准/执行条目和 M2 的系统条目
   拼成一条按时间排序的故事线。执行反馈并进审批行文案（"已执行（一次性 token
   用后即焚）"），因为 wire 里只有 executed 布尔没有执行时间戳，**编一个就是造假**。

## 新技术点四要素：fetch 流式读 SSE（POST 场景的另一半）

- **名字**：`fetch` + `ReadableStream` reader（ WHATWG Fetch/Streams 标准；
  本项目在 `services/web/src/chat.ts` 的 `streamChat`）。
- **作用**：票 20 的 `EventSource` 只能发 GET、不能带 `Authorization` 头——而
  `/api/v1/chat` 是 POST + Bearer 会话。fetch 的响应体本身就是个可读流，
  自己读、自己切帧。和 EventSource 的分工：**GET 长连要断线续传 → sse.ts；
  POST 一次性流 → chat.ts**（对话流后端是同步跑完再补发，"断线重连"的重发
  等于重新提问，没有续传可言）。
- **参数/机制**：`res.body.getReader()` → 循环 `read()` 拿 `Uint8Array` →
  `TextDecoder.decode(value, {stream:true})`（**stream:true 别漏**，中文跨 chunk
  才不会 decoded 成乱码）→ 按空行（`\n\n`）切帧，半帧留缓冲拼下一块。
  帧格式与票 20 见过的 `formatSse` 完全同款：`event: 名` + `data: JSON`。
- **用法（本项目）**：`streamChat({token, message, caseId, onFrame})`；
  帧进 `applyChatFrame` 归约成转录（token 拼答案、tool/denied 进过程行），
  与 pipeline.ts 的 `applyEvent` 同款不可变纪律。测试不走模块 mock——
  fetch 替身直接返回 `new Response(ReadableStream)`，粘包/半帧/尾帧全钉死
  （chat.test.ts，其中一个用例专测"空块不能凭空造出 message 帧"，这个 bug
  就是测试先抓到的）。

次新技术点一笔带过：
- **vite 插件静态面**：Eval 产物不建后端端点，vite.config.ts 里 15 行
  `configureServer` 中间件把 `/eval-results/*` 映射到磁盘目录，URL 与路径一致
  （curl 等价脚本直接 GET 同一路径核对）。原则同票 20 的"无特权"：页面只能
  展示产物里真实存在的字段——票 22 之前的 latest.json 没有 `attack_block_rate`，
  页面就如实标"未产出"，绝不合成数字。
- **路由快照**：`routes.ts` 导出 `ROUTES` 六行常量 + `isRouteName` 闭合判断 +
  `parseHash` 解析；菜单由表生成、页面开关由表驱动、`routes.test.ts` 快照断言
  表内容一字不差，App 壳测试再钉一层行为兜底（表外 hash 渲染的是告警列表）。
  "六页面之外无路由"从口号变成三道锁：表唯一、名字闭合、渲染兜底。

## 关键顿悟

- **范围锁死要靠"改不到的表"，不靠"不写的代码"**。只要路由表是个可以被顺手
  `push` 的数组，范围就会蔓延；把它变成 6 行常量 + 快照测试 + 表外名字一律
  兜底回告警列表，加页面就必须先过测试那关——红着进来的人会先想清楚这页
  是不是真该存在。
- **409 是设计的一部分，不是故障**。审批卡是"单决媒体"：pending 之外无路可走
  是状态机保证的（INV-10），两个值班长同时裁决，先到者定案、后到者 409。
  前端的职责是把 409 翻译成正常剧情的人话并刷新列表，而不是弹红色报错。
- **页面间跳转用 URL 参数（`#/cases?case_id=…`、`#/pipeline?run_id=…`）而不是
  组件传参**，跳转就是 `window.location.hash = …` 一行——刷新可恢复（PRD M10
  异常边界）、可收藏、可从脚本里拼出来直接开，天然和"curl 等价"同一套口径。
- **执行反馈合并进审批行，不编时间戳**。数据没有的字段（executed_at 没上 wire）
  页面就不装作有——"有写有读"的诚实原则在 UI 上的样子。

## 亲手验证

```bash
cd /Users/divh/Downloads/安全评估agent/soc-demo

# 0) 门禁（本票新增 35 个前端测试，合计 73）
cd services/web && pnpm test 2>&1 | tail -4
#   应看到：Test Files 11 passed | Tests 73 passed
cd ../.. && python3 tools/check_specs.py    # 应看到 spec gate: PASS（在 soc-demo/ 下执行）

# 1) 起一套最小栈（lessons/20-01 同款；agent 走 fake LLM，离线确定性；
#    compose 也可，但 gateway 与 agent 必须注入同一 SOC_HMAC_KEY，否则铸票 fail-closed）
(cd services/guards && ../../.venv/bin/uvicorn app:app --host 127.0.0.1 --port 8001 &)
(cd services/gateway && SOC_HMAC_KEY=smoke-key-demo ../../.venv/bin/uvicorn app:app --host 127.0.0.1 --port 8002 &)
(cd services/case-backend && pnpm start &)
(cd services/ingest && CASE_BACKEND_URL=http://127.0.0.1:3002 pnpm start &)
(cd services/agent && AGENT_LLM=fake SOC_HMAC_KEY=smoke-key-demo CASE_BACKEND_URL=http://127.0.0.1:3002 GUARDS_URL=http://127.0.0.1:8001 GATEWAY_URL=http://127.0.0.1:8002 pnpm start &)
(cd services/web && pnpm dev &)   # 缺省代理上游 127.0.0.1:3001/3002/3003

# 2) 六幕 curl 等价脚本（本票新增，全部走 Web 同源公开面）
bash scripts/web-smoke-21.sh
#   应看到：幕1→幕6 逐段 PASS，最后一行
#   "SMOKE PASS（票 21：六幕 curl 等价脚本核对全通——全部走 Web 同源公开面，零特权）"

# 3) 浏览器开 http://localhost:5173，以「值班长（SOC2+）」登录
#    → 告警列表点「回放 fixtures」→ 任一行「发起分诊」→ 流水线页节点亮起
#    → 告警列表「查案件」→ 案件时间线页出现系统条目；点「对话追问（Copilot）」
#      输入"隔离主机 centos7" → 抽屉里出现"提交审批卡"的过程行
#    → 菜单切「审批卡」→ isolate_host 待审批卡：点「批准」
#      → 绿 Tag「已批准」+「已执行」；开两个窗口同时批同一张卡，
#        后到者会看到"手慢了……（并发后到者 409）"
#    → 菜单恰好六项；手输 #/settings 之类 → 落回告警列表（表外无路由）

# 4) 捣乱实验（Eval 数据源）：
#    pnpm test:eval 重跑后再点 Eval 页「刷新（重读 latest.json）」→ run_at 变新
#    把 eval-results/latest.json 临时改名 → 刷新 Eval 页 → 红字提示"读
#    eval-results/latest.json 失败……跑过 pnpm test:eval 了吗？"（页面不猜数）
#
# 收摊：lsof -ti:3001,3002,3003,8001,8002,5173 | xargs kill
```
