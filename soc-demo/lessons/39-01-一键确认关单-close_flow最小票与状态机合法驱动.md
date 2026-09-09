# 39-01 · 一键确认关单：close_flow 上线（建议 → 确认 → 执行三段式收口）

> 票 39（G2-7 清偿）的教学文档。读前提问：跑通项目、看懂分诊（见 run-01-分诊.md、36-01）。

## 一、三问（这一阶段是干嘛的）

**位置感先行**——终极目标是 PRD 的六幕消息旅程，一张图标出你在哪：

```
告警接入(09) → 分诊(13) → FP/BTP 关单建议 → 【SOC1 一键确认(39)】 → Alert Closed → 审计留痕
   ✅ 上线      ✅ 上线       ✅ 只出主意       ⬜ 没人能按下去          ✅
                                  ↑ 本票（39）就是修这一格 ↑
```

- **这一阶段是干嘛的？** 分诊 agent 判"误报/良性真实事件"后，只在告警上写一句"建议关单"（`verdict_ai.recommended_action = "close"`）——然后就没有然后了：六个页面没有一个地方能把它执行掉（体检 G2-7：FP/BTP 关单建议无人可执行）。本票在 web 告警页加一个"确认关单"按钮，SOC1 点下去，告警真的变 `Closed`。
- **什么需求逼我们这么设计？** PRD FR-M4.5 的演示口径："FP/BTP 产出关闭建议（**演示默认 SOC1 一键确认后 L1 执行**）"。也就是说演示里不搞全自动关单——AI 出主意，人按按钮，系统按规矩执行。三方各干各的活。
- **解决了什么麻烦？** 两个麻烦叠加：① **状态机的规矩**——alert 不许从 New 直接跳 Closed（INV-10，非法迁移一律 409），票 13 偏差②早就预告过"执行 close_alert 前需先置 InProgress"；② **安全的规矩**——`close_alert` 是 A.1 里的 L1 写工具，执行必须持任务票过验票闸（m9 的命根子），不能让网页直接捅 case-backend 的 REST 口了事。

## 二、全链路一览

```
web 告警页（soc1 / duty_lead / admin 看得见按钮；红队看不见）
  │ 点「确认关单」→ Popconfirm 再问一遍「确认执行 AI 关单建议？」
  ▼
POST /internal/runs {kind:"close_flow", alert_id}   请求头带上 x-actor-id（谁按的）
  │  m3 的 run 拉起面——和「发起分诊」同一扇门（m4 卡说好"无独立 HTTP 面"，不破例）
  ▼
铸最小任务票 ……………………………… allowed_tools=[get_alert, close_alert]，scope=[alert:update]
  ▼
┌─ close_flow 两节点（workers/triage/close.ts）──────────────┐
│ ① load_close_target                                        │
│      get_alert（L0 读，过闸）→ 预检三连：                  │
│        verdict 定了没？ 建议是不是 close？ 是不是已经关了？ │
│      任一不过 → 具名错误（close_verdict_missing 等），run 失败 │
│ ② execute_close                                            │
│      close_alert（L1 写，过闸）→ 闸【内】的动作：          │
│        PATCH status=InProgress（New→InProgress，票 13 偏差②补的前置）│
│        POST /close {verdict}（InProgress→Closed，合法落地）│
└──────────────┬─────────────────────────────────────────────┘
               ▼
   留痕三处（INV-8）：agent 侧 close_confirm 审计（记确认人）──HttpAuditSink──► M2 audit_entries
                      M2 自己的 diff 审计（New→InProgress、InProgress→Closed 两条）
   时间线留痕：run 事件流（tool_call / tool_result / audit 镜像）——流水线视图可见
               ▼
   web 订阅这条 run 的 SSE → 收到终态 → 人话提示 + 刷新列表
```

## 三、跟着数据走（web-31103 那条 CGI 500 告警，一步步看）

1. **建议诞生**：回放后对它发起分诊。伪 LLM 按决策点判它是运维噪声 → `verdict=fp`、`recommended_action=close`，写进 `verdict_ai` 落库；alert 状态留在 `New`（关不关等 human 表态）。
2. **按钮现身**：告警页加载列表，`closeAdvised(verdictAi)` 检查——verdict 是 fp/btp **且**建议是 close **且**还没 Closed，三条全中才渲染"确认关单"按钮。当前角色还得在 soc1/duty_lead/admin 里（A.2 矩阵：close_alert 属案件写入族，红队全 ——所以红队登录连按钮都看不见）。
3. **soc1 按下**：`POST /internal/runs {kind:"close_flow", alert_id}`，请求头 `x-actor-id: soc1@soc.local`。agent 铸票：票面就两件工具（读一条告警 + 关一条告警）。
4. **先看清，再动手**：`load_close_target` 过闸调 `get_alert`，拿回 `verdict=false_positive`、建议 `close`、状态 `New`——预检三连全过。
5. **动手（全在闸内）**：`execute_close` 让 verifyTicket 验"close_alert 在不在票面"→ 在 → 执行动作：先 `PATCH {status:"InProgress"}`（New→InProgress，合法），再 `POST /close {verdict:"false_positive"}`（InProgress→Closed，合法）。告警 `Closed` 落地。
6. **留痕**：agent 审计一条 `close_confirm`，`actor = {type:"user", id:"soc1@soc.local"}`（按按钮的人进档案）；M2 自己也记了两条状态 diff 审计；run 事件流里 tool_call/tool_result/audit 镜像全程可见。
7. **回声**：web 订阅这条 run 的 SSE，收到 `audit` 镜像 `status→completed` → 绿色提示"关单完成：…已 Closed（New→InProgress→Closed 合法路径）"，列表刷新，那行状态 Tag 变灰的 Closed，按钮消失。
8. **捣乱实验**：假设另一个分析师手更快先关了，你再点（curl 重发也一样）→ `load_close_target` 看见状态已是 Closed → 抛 `close_already_closed` → 你收到"手慢了：这条告警已经是关单状态（可能已被别人确认）"。闸也真的拦过：票面缺 close_alert 时，连先置 InProgress 都不会发生，告警一个字节不动。

## 四、新技术点：具名错误串当跨端契约

- **名字**：worker 具名失败（`close_verdict_missing` / `close_advice_missing` / `close_already_closed` / `m2_close_failed:InvalidTransition`），没有正式名字，大家叫它"错误码当接口"。
- **作用**：失败也得让人看懂。run 失败的 message 会顺着 failReason 和 error 事件一路带到浏览器，web 的 `closeRunFailText` 按前缀映射成人话；认不出的前缀**原样透传，不编理由**。
- **用法**：后端 `throw new Error("close_xxx:" + alertId)`；前端 `message.includes("close_xxx")` 就地翻译。和票 21 审批卡的 `decideErrorText`（"手慢了：这张审批卡刚被别人裁决过（并发后到者 409）"）是同一个套路的第二次使用——一处先例、两处复用，就算形成惯例了。

## 五、关键顿悟

- **执行放哪一侧不是小事**。选项 b（web 直调 case-backend 的 /close）两行代码就"能关"，但 m9 的命根子——每个工具调用过 verifyTicket——就被整个跳过了，"L1 任务票"成了一句空话。票面白纸黑字写"以 L1 任务票执行"，所以选 a：agent 侧起一条 close_flow run，闸、审计、时间线全在轨道上。
- **最小票是算术不是口号**。close_flow 的票面只有 `get_alert` + `close_alert` 两件、scope 只有 `alert:update`——分诊票里的 kb_lookup/create_case 在这里一样都用不上，用不上就不该发。票面是能力的上界，多发一分就是白送一分攻击面。
- **fail-closed 要 closed 到底**。"先置 InProgress"如果写在闸外，那么票面缺 close_alert 的 run 会先把告警改成 InProgress 再死——留下一堆半途告警。把它放进闸内的动作里：没票，一个字节都不许动。
- **按钮显隐只是第一道收窄，真闸永远在服务端**。前端按角色藏按钮是体验；就算有人绕过页面硬发请求，后面还有任务票、状态机、审计三层兜底——UI 不可信，这是全场反复出现的主题。

## 六、亲手验证

前置：compose 起来（或本机 `pnpm dev` 各服务），已回放 fixtures 并对 web-31103 那条告警跑过分诊（流水线视图或告警页"发起分诊"）。

1. 以 SOC1 登录 web（:5173）→ 告警列表：web-31103 那行（fp 标签、状态 New）应出现"确认关单"按钮；刚回放还没分诊的告警**没有**这个按钮。
2. 点"确认关单"→ 再点"确认执行关单"→ 应看到绿色"关单完成：…已 Closed…"；该行状态变 Closed、按钮消失。
3. curl 等价（不点按钮，直接打正门）：
   ```bash
   curl -s -X POST http://127.0.0.1:5173/internal/runs \
     -H 'content-type: application/json' -H 'x-actor-id: soc1@soc.local' \
     -d '{"kind":"close_flow","alert_id":"<告警id>"}'
   curl -s http://127.0.0.1:3002/api/v1/alerts/<告警id> | grep -o '"status":"[A-Za-z]*"'   # 应见 "Closed"
   curl -s "http://127.0.0.1:3002/api/v1/audit?objectId=<告警id>" | grep -o 'close_confirm\|New->InProgress\|InProgress->Closed'  # 三处留痕都在
   ```
4. 捣乱实验：对**同一条**告警再发一次上面的 curl → 应收到 202（run 受理），但提示失败路径：`curl -s "http://127.0.0.1:5173/api/v1/events/stream?run_id=<新run_id>"` 里 error 帧带 `close_already_closed`；网页上对已 Closed 的行按钮已消失（不猜、不重复关）。
