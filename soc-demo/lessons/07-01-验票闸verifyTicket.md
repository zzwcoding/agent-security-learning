# 07-01 · 票 07：验票闸 verifyTicket——一切工具调用前的门卫

## 三问

**位置感**：m9 安全控制面三连的第二件：

```
票01 CI ✅ → 票02 票面契约 ✅ → 票03 数据地基 ✅ → 票04 guards ✅ → 票05 MCP体检 ✅ → 票06 铸票 ✅
→ 票07 验票闸(TS) ✅你在这里 → 票08 凭证代理 → 票10 编排骨架 → worker 大军 → 票11 审批回路
```

- **这一步是干嘛的？** 给 agent（TS 侧）装上门卫：`verifyTicket(toolCall, ctx, now)`。
  以后每个工具调用执行前都得过它——LLM 嘴上说「我要调 isolate_host」不算数，得看它
  递上来的票：钢印（HMAC 签名）真不真、过没过期、烧没烧过（一次性）、工具在不在票面
  清单上、案件/run 对不对、参数动没动。六问全过才放行，任何一问答不上就 403。
- **什么需求逼我们这么设计？** PRD 的根假设：**LLM 是不可信的决策者**。分诊 agent 可能
  被注入话术（票 04 的文本防线管内容）诱导去调高危工具，所以还需要一道权限防线管身份
  ——两层合起来才是纵深防御（FR-S3.3）。而且拒绝要有名字：六种 403 reason 一个坑一个
  名字（FR-S2.2），不许含糊地「不让过」——红队演示时每道闸被撞开哪扇都要报得出名。
- **解决什么麻烦？** 票 06 让 py 侧会**铸票**了，但跨语言契约（ADR 0001）还差另一半：
  TS 验票侧必须对**同一批历史票、同一张期望结果表**全绿，两端才算咬死。同时票 03 造的
  焚毁表 used_tokens 在这里第一次有了「读它防重放」的消费者——INV-2 的闭环补完最后一环。

## 全链路一览

```
LLM 说：「我要调 isolate_host(host=web-01)」      ← 不可信决策者的愿望，只是个申请
        │
        ▼
verifyTicket(toolCall, ctx, now)   ← 门卫，本票全部逻辑（services/agent/src/verify-ticket.ts）
        │
        ├─ ① 有票吗？─没有─→ L0 只读：放行 ／ L2 高危：403 require_approval ／ L1 写：403 no_ticket
        ├─ ② 验钢印（HMAC）─不符─→ 403 signature_invalid（涂改过的票连 JSON 解析器都进不了）
        ├─ ③ 验时效 exp ─过期─→ 403 token_expired
        ├─ ④ 查焚毁表 used_tokens ─烧过─→ 403 token_used（重放攻击死在这）
        ├─ ⑤ 验 scope／参数指纹：任务票看 allowed_tools；审批票比对 params_hash
        │        ─不符─→ 403 scope_insufficient ／ params_mismatch
        ├─ ⑥ 验 case/run 绑定 ─对不上─→ 403 scope_insufficient（票不是万能通行证）
        ▼
   allow（附票面 payload）→ 执行方干完活，把 jti 登记进 M2 used_tokens → 焚毁
```

①是**闸控制流**（没带票/L2 无审批铸票，不由票面 fixture 覆盖），②~⑥是**票面校验**——
顺序与 py 铸币侧 `mint.verify()` 同序：签名 → 时效 → 焚毁 → scope/参数，最致命的先问。

## 跟着数据走：捣乱者捡到一张用过的票

拿契约真票 `approval-token/valid`（isolate_host web-01，值班长 duty_lead 批的）走两遍。

**第一遍，正路：**

1. **切三段验钢印**：`token.split(".")` 得头、票体、hex 钢印。用测试密钥对
   `"b64头.b64票体"` 重算 HMAC-SHA256，和第三段恒时比对——咬合，是铸币厂的章。
2. **验时效**：注入 `verify_now = 1757000060`（契约禁 wall clock）< `exp = 1757000300`，没过期。
3. **查焚毁表**：jti `ap_01J9X7Q0TEST0000012` 不在 used_tokens，不是重放。
4. **验工具和参数指纹**：票面锁的 tool 就是 `isolate_host`；实际参数 `{host:"web-01"}`
   重算 sha256 指纹 = `sha256:b8dc6b29…`，和票里的 params_hash 一字不差。
5. **allow**——执行方去真的隔离 web-01，干完把 jti 登记进焚毁表（测试里是
   `MemoryBurnRegistry.burn`；生产是 POST /internal/used-tokens 到 M2，审计同库同事务）。

**第二遍，捣乱者把同一串 token 原样再递一次**（一个字节没改）：

钢印是真的、票也没过期——但第 ④ 步一查焚毁表，jti 在案。**403 token_used**，INV-2
「用后焚毁、重放必 403」的全部机制就这一查。对照另一张捣乱票 `task-ticket/payload-tampered`：
票体 case_id 被涂改成 case_000099，第 ② 关钢印对不上就被毙，**根本轮不到 case 绑定检查**
——如果顺序反了，闸只会报一个似是而非的 scope_insufficient，还误导排障的人。

## 新技术点：node:crypto 的验签三件套（py 钢印机的 TS 孪生）

- **名字**：`createHmac` / `createHash` / `timingSafeEqual`，Node 标准库 `node:crypto`，零依赖。
- **作用**：票 06 的 py 钢印机（`hmac.new`）在 TS 侧的对应机器——同一把钥匙、同一串字节，
  必须压出同一个 hex 章，跨语言契约才咬得上。`timingSafeEqual` 对位 py 的
  `hmac.compare_digest`：恒时比较，防「按响应时间逐字节试探签名」。
- **参数**：
  - `createHmac("sha256", key).update(unsigned, "utf8").digest("hex")`——key 必须
    `Buffer.from(key, "utf8")` **原始字节**（无 hex 解码无 KDF，contract.json 的约定）；
    digest 用 `"hex"` 得 64 字符串，就是票的第三段（教学变体，非 JWT 标准的 b64 段）。
  - `timingSafeEqual(a, b)` 只吃 Buffer 且**长度不等会抛异常**——先比长度再比较。
  - `Buffer.from(seg, "base64url")` 一行顶 py 的补 `=` + `urlsafe_b64decode`。
- **用法**（verify-ticket.ts 的全部家当）：
  ```ts
  function signHex(key: Buffer, unsigned: string): string {
    return createHmac("sha256", key).update(unsigned, "utf8").digest("hex");
  }
  function sigMatches(expectedHex: string, got: string): boolean {
    const a = Buffer.from(expectedHex, "utf8"), b = Buffer.from(got, "utf8");
    return a.length === b.length && timingSafeEqual(a, b);
  }
  ```
  本项目用在哪：`services/agent/src/verify-ticket.ts` 的 `signHex/sigMatches/unseal`；
  params_hash 的 TS 端是 `paramsHash()`——py `json.dumps(sort_keys=True,
  separators=(",",":"))` 对位成「递归排好键再 `JSON.stringify`」（stringify 本身无空格），
  期望值由 py 同参算出锁死在测试里，嵌套键序 + 中文一字不差。

## 关键顿悟

- **裁决顺序本身就是安全设计**。签名 → 时效 → 焚毁 → scope/参数 → 绑定：涂改票在第②关
  就地正法，轮不到后面的检查给它一个体面的死法；重放票在焚毁关死掉，不会浪费真 jti。
  把最致命的问题放最前面，答不上立刻短路——fail-closed 不是一句口号，是一个具体的顺序。
- **TS 的 fail-closed 得自己动手**。py 里 payload 缺字段会 KeyError 自己炸出来、被 except
  接住归 403；TS 读到 `payload.exp` 是 undefined 时，`now >= undefined` 结果是 false——
  不显式验型，坏票就静默滑过去了。语言不同，坑不同，纪律相同：闸体整体 try/catch，
  任何异常（焚毁表炸了、密钥没配、参数序列化失败）一律 403 `signature_invalid`。
- **焚毁的真相在库不在票**。票面 payload 里的 `used` 永远是铸造时的 false，谁也不去改它
  （改了签名就废）；「用没用过」的唯一真相是 M2 used_tokens 表。闸只**读**表，执行方
  干完活才**写**——「用后焚毁」的「后」字就落在这个先后顺序上，验票时焚毁等于把票浪费
  在执行失败上。
- **空字符串票是坏票，不是没票**。`if (ctx.ticket)` 会把 `""` 当「没带票」报 no_ticket，
  语义就撒谎了——TDD 红灯抓的第一个 bug 就是它。用 `typeof ctx.ticket === "string"` 判
  分支，让坏票老老实实走 signature_invalid。拒绝原因报得准，红队演示才可信。

## 亲手验证

```bash
cd /Users/divh/Downloads/安全评估agent/soc-demo

# 1. 验票闸 26 个测试（九张 fixture 契约 + 六 reason + 重放 + 伪造审批 + 绑定 + 延迟 + fail-closed）
cd services/agent && pnpm vitest run src/verify-ticket.test.ts
# 应看到：26 passed，外加一行延迟实测（task/approval 两条路径都在 0.01ms 量级，预算 5ms）

# 2. 跨语言对账：同一批 fixture，py 铸票侧（票 06 的契约自检）同样要全绿
cd ../gateway && ../../.venv/bin/python -m pytest -q test_ticket_fixtures.py
# 应看到：8 passed——铸票侧与验票侧对同一批历史票给出完全相同的裁决

# 3. 全仓门禁（与 CI 同款四件套）
cd ../.. && pnpm lint && pnpm typecheck && pnpm test && python3 tools/check_specs.py
# 应看到：4 个包 typecheck Done、全部测试绿、spec gate PASS（5 条规划警告与本报无关）

# 4. 捣乱实验：把 verify-ticket.test.ts 重放测试里的 used.burn(...) 那行注释掉再跑第 1 步
# 应看到：重放测试红——第二次验票放行了。这一行就是 INV-2 的全部：没有焚毁登记，一次性无从谈起
# （验完记得把那行还原）
```
