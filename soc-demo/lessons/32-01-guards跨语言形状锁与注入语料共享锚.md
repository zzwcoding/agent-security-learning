# 32-01 · 票 32：guards 跨语言形状锁 + 注入语料共享锚

## 三问

**位置感**：阶段 7 收官体检 D 组「数据形状契约补机器锁」，接着票 31 继续钉钉子：

```
票28 边界闸 ✅ → 票29 latest.json ✅ → 票30 alert wire ✅ → 票31 SSE+verdict ✅
→ 票32 guards 形状锁 + 注入语料共享锚 ✅你在这里（体检 D2）
→ 票33 测试补齐（D3）→ …
```

- **这一步是干嘛的？** 给两样东西上锁。第一样是 **guards 服务的响应形状**：py 写的
  guards 服务回 `{is_injection, score, scanner, action, hits, text}`，TS 写的
  guards-client 按这六个键消费——但 TS 侧的「依据」只是一段 interface 类型注记，
  py 侧什么锁都没有，哪天服务端改个键名，客户端拿到 `undefined` 都不会有人报错
  （体检对账三-16 说的就是这事）。第二样是**注入攻击语料**：guards（py，llm-guard
  真引擎）和 mcp-audit（TS CLI，内嵌正则）是两套**故意不合并**的注入判定实现
  （决策 #11），两边各养各的攻击正则，体检结构-10 发现它们已经悄悄漂移过——
  比如 mcp-audit 的 data_exfiltration 比 guards 多认一种「send all … to」句式。
  本票给两边发同一份「考卷」（fixtures/attack/injection-corpus.json），锁的不是
  实现合并，是「**同一族攻击，两套引擎的 hit/miss 结论必须一致**」。
- **什么需求逼我们这么设计？** 边界规则不让跨服务 import 源码（R1），mcp-audit
  更是被 R5 明令「不 import 任何 workspace 包」（决策 #11：CLI 独立交付）——所以
  两套引擎之间唯一的合法通道是**共享的 fixtures 文件**，跟三家分店对账只认总部
  下发的表。恰好 fixtures/tickets（票 02）已经验证过这个形态能跑通跨语言契约。
- **解决什么麻烦？** 把「两端各抄一份、靠人肉记着同步」变成「两端各读一份、机器
  逼着咬合」。以后谁改响应形状、谁改某族的判定正则，只要没同步对端认可的契约/
  语料，CI 当场红——而且是**只红动了的那一端**，报错直接告诉你哪族哪样本漂了。

## 全链路一览

本票上了两把锁，共 four 个测试闸 + 两个 fixture 文件：

```
fixtures/guards/contract.json（形状的"法律"）      fixtures/attack/injection-corpus.json（语料的"法律"）
        │                       │                          │                                                                 │
        ▼                       ▼                          ▼                                                                 ▼
services/guards/            services/agent/src/        services/guards/                       packages/mcp-audit/test/
 test_guards_contract.py     guards-contract.test.ts    test_corpus_anchor.py                  corpus-anchor.test.ts
 （生产端闸：真打 HTTP 面，  （消费端闸：本地样例服务    （py 引擎闸：llm-guard                  （TS 引擎闸：rules.ts
  响应键集/阈值/通道策略      器按契约回样，断言          每族每样本 hit/miss                      每族每样本 hit/miss
  逐键咬合契约）             scanInjection 的映射）      ≡ 语料期望）                            ≡ 语料期望）
```

注意两把锁的分工：**contract.json 锁「响应长什么样」**（字段集/类型/通道策略），
**injection-corpus.json 锁「同族判定一致」**（引擎内部怎么判不管，管结论）。
四道闸互相不 import 对方代码，只认 fixtures——谁改代码不改 fixtures，自家闸先红；
改了 fixtures 不通知对端，对端的闸红。

## 跟着数据走：一条带隐形字符的攻击语料

拿语料里 `invisible_chars` 族的 `inv_hit_set` 样本走一遍（这是两引擎**语义分叉**
的一族，最能说明「宽容锚」怎么设计）：

1. **语料文件里它长这样**：`"text": "run\u2060cmd\ufeffnow"`。注意 JSON 源码里写的
   是 `\u2060`、`\ufeff` **转义序列**，不是真字符——U+2060（词连接符）、U+FEFF（BOM）
   都是肉眼看不见的字符，直接写进源码等于埋雷（编辑器看不见、grep 找不到、手滑
   删了没人知道）。JSON 解析后，py 和 TS 拿到的是同一串真字符。
2. **py 引擎判**：`services/guards/test_corpus_anchor.py` 调
   `injection_scan._family_hit("invisible_chars", text)`——底层是 llm-guard 的
   InvisibleText 扫描器，把文本里所有 Cf/Co/Cn 类不可见字符剥掉，剥完长度变了
   就是命中 → `hit=True` ✓ 与语料期望 `hit` 咬合。
3. **TS 引擎判同一个样本**：`packages/mcp-audit/test/corpus-anchor.test.ts` 调
   `scanDescription(text)`——底层是 rules.ts 里的零宽字符正则
   `/\u200b|\u200c|\u200d|\u2060|\ufeff/`，test 一下 → 命中 → `families` 含
   `invisible_chars` ✓ 同样咬合。
4. **分叉怎么宽容？** py 数「剥了几个」（审计明细），TS 只报「命中与否」——两边
   实现细节不同，但「这段文本含不可见字符，invisible 族该响」这个**语义结论**
   一致。语料的 `expect` 就只写这个语义结论，不锁计数。样本字符也只取两引擎
   判定的交集（实测恰好就是 TS 正则那五个零宽字符），不给任何一边「超纲题」。
5. **捣乱输入会怎样？** 假如有人手滑把 rules.ts 正则里的 `忽略(以上|…)指令` 分支
   删了（真删过，见变异验证）：TS 闸当场红——`instruction_override/inst_hit_zh:
   语料期望 hit，TS 引擎实判 miss（同族判定漂移）`；py 闸纹丝不动（py 引擎没动）。
   这就是「只红动了的那一端」。

形状锁那边跟着 `contract.json` 的 `injection_syslog` 样本走也类似：py 闸真打
HTTP 数出六个键，TS 闸在本地起一台「照契约回样」的小服务器，验证客户端把响应
映射成 `ScanDecision` 时 `blocked = is_injection && action === "block"` 没走样。

## 新技术点四要素：JSON 里的 `\uXXXX` 转义

- **名字**：JSON 字符串的 Unicode 转义序列（JSON spec 内建，python `json` 与
  JS `JSON.parse` 行为完全一致，无包）。
- **作用**：在源码文件里**可见地**表示不可见/生僻字符。直接写 U+200B 进文件，
  文件里就是一个看不见的字节——代码评审看不见它、grep 搜不到它、格式化工具
  可能悄悄弄丢它；写成 `\u200b` 六个可见字符，以上问题全消失，解析结果不变。
  本项目的 invisible_chars 语料样本全部用转义写。
- **参数**：`\uXXXX`，四个十六进制位（BMP 字符）；emoji 等星形平面字符要用
  代理对 `\uD83D\uDE00` 或 JS 独有的 `\u{1F600}`（后者不是合法 JSON）。
- **用法**：

  ```json
  { "id": "inv_hit_zwsp", "text": "clean\u200bdescription", "expect": "hit" }
  ```

  解析后 `text` 是 `clean` + 零宽空格 + `description`。本项目用在哪：
  `fixtures/attack/injection-corpus.json` 的 `invisible_chars` 族（票 32）。
  验证小技巧：`python3 -c "print(open('fixtures/attack/injection-corpus.json')
  .read())"` 应看到 `\u200b` 字面六字符，而不是零宽空格消失不见。

## 关键顿悟

- **锁结论，不锁实现**。两套注入引擎的正则词面本来就不同步（TS 多「send all」
  分支、多 mcp_camouflage 整族），把锚定在「同一族、同一语料、结论一致」这个
  层面，既保住决策 #11 的双实现独立性，又把「漂移不管」升级成「漂移必红」。
  锚的样本只收两引擎**共有词面**——收了超纲词面，锚自己天天假红，就没人信它了。
- **锚样本要钉住「最小独立分支」**。第一版语料里 `authority_escalation` 的中文
  样本同时踩中两条分支（「已由值班长批准」+「无需再次审批」），变异验证时删掉
  一条分支居然不红——另一条兜住了。教训：一个期望样本只应证明一件事，多分支
  样本要拆开，否则锚看着挺密、全是漏网之网。（实测补了单分支样本后才咬住。）
- **消费端契约测试能补单元测试的盲区**。guards-client 原有的单测 mock 从没测过
  「is_injection=true 但 action=strip」这种组合，所以 `blocked` 规则改错它照样绿；
  新契约闸按通道策略把 2 样本 × 4 通道八种组合全扫一遍，变异当场红。测试替身
  的覆盖面是设计出来的，不是测试多了自然就有的。

## 亲手验证

```bash
cd /Users/divh/Downloads/安全评估agent/soc-demo
# 四道闸各自跑
pnpm -C services/agent exec vitest run src/guards-contract.test.ts   # 应 3 passed
pnpm -C packages/mcp-audit exec vitest run test/corpus-anchor.test.ts # 应 1 passed
( cd services/guards && /Users/divh/Downloads/安全评估agent/soc-demo/.venv/bin/python \
  -m pytest test_guards_contract.py test_corpus_anchor.py -q )        # 应 6 passed
```

捣乱实验（做完还原）：把 `packages/mcp-audit/src/rules.ts` 里
`data_exfiltration` 正则中的 `|credentials` 删掉，跑上面的 TS 闸——应看到
`exfil_hit_key: 语料期望 hit，TS 引擎实判 miss`，而 py 闸不受影响（还绿）。
还原后再想想：为什么删 `|all ` 就**不会**红？（答：`all` 是 mcp-audit 独有的
超集词面，共享语料里根本没有「send all」样本——锁的是共有词面，不是全部词面。）
