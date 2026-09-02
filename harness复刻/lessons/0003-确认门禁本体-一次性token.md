# 0003 - 确认门禁本体:一次性 token 的签发与验票

## 1. 三问(阶段动机)

**位置感**——终极目标:让系统自己长出门禁。诊断器(阶段 2)已经立案说"调度器缺确认门禁",这一阶段先把**门禁本尊**写出来:

```
✅01 缺陷现场 → ✅02 诊断聚簇 → ✅03 确认门禁本体 → ▶️04 提案打包(下一站)
→ ⬜05 静态闸 → ⬜06 隔离回放 → ⬜07 全量门槛 → ⬜08 反例必拒
→ ⬜09 发布决定 → ⬜10 验收入口 → ⬜11 真实LLM → ⬜12 加固门禁 → ⬜13 收官对照
```

**这一阶段是干嘛的?** 新增独立模块 `confirmation_gate.py`:高风险调用先挂起,拿一次性确认 token 来验,验过才放行执行。它就是后面"提案流水线"要生成的东西——先手写一遍,阶段 4 再把它包装成"Coding Agent 的提案"。

**什么需求逼我们这么设计?** 阶段 1 的缺陷是"没确认就执行"。最直觉的修法是"高风险就拒绝"——但对照轨迹 0725 告诉我们用户**同意后**的删除是正当需求,一刀切拒绝会把系统改残。所以需要"挂起 + 确认"两段式:第一次调用挂起等确认,确认后凭票放行。而"确认"必须防三种赖账:票被偷去干别的事、一张票反复用、无票硬闯。

**它解决了什么麻烦?** 用"**指纹绑定的取件码**"一次解决三件事:签票时把"工具名+完整参数"压成指纹存在票上;验票时重算指纹比对——参数差一个字母都对不上(防挪用);票取出即作废(防复用);没票或假票一律 `rejected` 且**绝不执行**(防硬闯)。

## 2. 全链路一览

```
                 ┌──────────────────────────────────────────┐
                 │        gate.dispatch(工具, 参数, execute) │
                 └──────────────────────────────────────────┘
                              │
                    classify() 打分:高风险?
              ┌──────否──────┴──────是──────┐
              ▼                             ▼
        低风险:直接执行              有 confirm_token 吗?
   (executed, confirmed=false)      ┌──无──┴──────有──────┐
                                    ▼                     ▼
                          pending_confirmation      从 _pending 取票(pop,取出即作废)
                          (挂起,绝不执行)                 │
                                    │                指纹比对(compare_digest)
                                    │              ┌──不符/无票──┴──吻合──┐
                                    │              ▼                     ▼
                                    │          rejected(绝不执行)   放行执行
                                    │                                (executed, confirmed=true)
                                    ▼
                          消费者:调用方拿着 pending 去问用户,
                          用户同意后调 issue_confirmation 签票,持票重试
```

签票侧:`issue_confirmation` → `_fingerprint`(canonical JSON + SHA-256)→ token = HMAC(指纹)[:24] → 存进 `_pending[token] = 指纹`。

## 3. 跟着数据走:删 notes/todo.md 的完整旅程

1. **第一次调用(无票)**:`dispatch("delete_file", {"path": "notes/todo.md"}, execute=...)`。`classify` 返回"删除文件不可逆……"→ 高风险;`confirm_token` 是 None → 返回 `{"status": "pending_confirmation", "reason": ...}`。**execute 没被碰**,文件还在(demo ①:执行器调用 1→1)。
2. **用户同意,签票**:`issue_confirmation("delete_file", {"path": "notes/todo.md"})` 先算指纹——canonical JSON 是 `{"args": {"path": "notes/todo.md"}, "tool": "delete_file"}`(sort_keys 排好序),SHA-256 压成 64 位十六进制指纹;再 `hmac.new(指纹, b"confirmation-gate", sha256).hexdigest()[:24]` 得到 24 位 token,连同指纹存进 `_pending`。
3. **持票重试**:再次 `dispatch` 同样的调用。这次有票 → `_pending.pop(token)` **取出即作废**;`compare_digest(存的指纹, 重算的指纹)` 吻合 → 执行 `execute(...)`,返回 `{"status": "executed", "confirmed": true, ...}`(demo ②:调用 1→2,文件消失)。
4. **捣乱输入一:复用旧票**。拿同一张票去删 `tmp/cache-0417.tmp` → `pop` 返回 None(票在上一步已作废)→ `rejected`,执行器纹丝不动(demo ③:调用 2→2)。就算票没用过,删除目标不同 → 指纹不同 → 也照样 `rejected`(这就是 boundary 用例 b-007"为 A 签的票删不了 B")。
5. **捣乱输入二:伪造票**。`confirm_token="forged-token-123"` → `_pending` 里查无此票 → `rejected`。

## 4. 新技术点:hmac.compare_digest

- **名字**:`hmac.compare_digest(a, b)`,标准库 `hmac`,恒定时间字符串/字节串比较
- **作用**:普通 `==` 比较字符串,遇到第一个不同字符就返回,耗时随"前缀匹配长度"变化——攻击者能靠测耗时一位一位试出正确指纹(时序攻击)。`compare_digest` 无论差在哪都花一样的时间,把这条侧信道堵死。你的主线阶段 42 手写任务票用的同一招,两个项目在这里撞出了同一条安全常识
- **参数**:两个 str 或两个 bytes(混用报错),返回 bool
- **用法**:`confirmation_gate.py:73` 的验票。凡是**比较密码/指纹/MAC**的地方都该用它,而不是 `==`

顺带一个眼尖的发现:参考模板的 token 是 `hmac(指纹, 固定盐)` **算出来的**——同一个操作永远签出同一张票(确定性),而不是随机数。单次性靠 `pop` 保住,但"猜中票"的难度全押在指纹上。阶段 12 的企业版门禁会换 `secrets.token_hex` 随机签票,到时候对照。

## 5. 关键顿悟

- **token 不是万能钥匙,是"写着具体哪件事"的取件码**:绑定工具名+完整参数的指纹,删 A 的票删不了 B,改一个参数就作废。主线任务票管"本轮行为 scope",这里的票管"这一次调用",粒度差一个量级。
- **单次性的实现就一个字:pop**。取出即作废,第二次必然查无此票。不需要时间戳、不需要状态机——数据结构选对了,安全性质是白送的。
- **门禁不碰工具,execute 是注入的**:门禁只回答"放行/挂起/拒绝",真正干活的是外面递进来的函数。这正是阶段 6 隔离回放能成立的前提——验证器递进去一个假执行器,门禁在完全不知情的情况下被验完,全程碰不到真环境。
- **诚实边界**:门禁跑在 Agent 进程内,进程被破就能自己签票——和主线任务票"进程级代码执行可自签票"同一个结论:进程内令牌管行为收窄,身份与审计必须靠进程外的网关/FGA,纵深防御缺一不可。

## 6. 亲手验证

```bash
cd /Users/divh/Downloads/安全评估agent/harness复刻
python3 demo.py
```

应看到阶段 3 四行:⓪ `read_file → executed`;① `pending_confirmation` 且执行器调用 **1→1**、文件还在 `True`;② `executed`、调用 **1→2**、文件还在 `False`;③ `rejected`、调用 **2→2**、缓存文件还在 `True`。

**捣乱实验**:在 demo 阶段 3 段末尾加两行——

```python
t2 = gate.issue_confirmation("delete_file", {"path": "tmp/cache-0417.tmp"})
print(gate.dispatch("delete_file", {"path": "notes/todo.md"}, execute=execute, confirm_token=t2))
```

为"删缓存"签的票拿去"删 todo"——应看到 `rejected`。这就是"指纹绑定":票上写着的那件事,和实际要做的事,差一个字都不行。
