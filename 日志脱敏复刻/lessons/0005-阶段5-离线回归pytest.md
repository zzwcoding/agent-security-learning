# 0005 — 阶段 5:离线回归(pytest 护住规则资产)

> 本阶段代码:`tests/conftest.py` + `tests/test_rules.py`(7 个测试)、`requirements.txt`、`.venv`(建环境)。

## 1. 三问:这一阶段是干嘛的?

**位置感**:

```
✅ 1-4 规则引擎(18 条,完工)  ✅ 5 回归锁   ← 你在这里
⬜ 6-8 LLM 引擎 → 9 混合管道 → 10 campaign → 11 对照收官
```

- **干嘛的?** 给 18 条规则装"问责机制":7 个 pytest 测试,每个锁住一个"曾经差点写错"的边界。全绿才算引擎完工。
- **什么需求逼的?** 规则是**资产也是负债**:每条正则都在"某个形状"上生效,后人(三个月后的你自己)改任何一条——比如嫌 `sk-` 正则太长把 `{20,}` 改成 `{10,}`——都可能让别的规则误伤别的文本。没有回归,这种伤是无声的。
- **解决什么麻烦?** "我以为还是对的"和"它真的是对的"之间的差距。测试就是把这个差距变成机器可判定的一行红字。

## 2. 全链路一览(测试怎么挂进项目)

```
tests/test_rules.py(7 个边界测试)
      │ import regex_sanitizer —— 怎么找到它?
      ▼
tests/conftest.py:把项目根挂进 sys.path(pytest 约定:conftest 先于测试执行)
      ▼
.venv/bin/python -m pytest tests/ -v(纯离线,0.01s,不碰网络不碰模型)
```

本项目前四个阶段零依赖,这是**第一个要装依赖的阶段**——正好把 Python 项目环境惯例一次讲清:

```bash
cd /Users/divh/Downloads/安全评估agent/日志脱敏复刻
uv venv .venv                                   # 造一个隔离环境目录
uv pip install --python .venv/bin/python -r requirements.txt   # 往这个环境里装(venv 里没有 pip 模块)
.venv/bin/python -m pytest tests/ -v            # 用环境的 python 跑测试
```

venv 比喻:**一次性餐盒**——项目自带的一套独立餐具柜,不污染系统全局的餐具;`.venv/` 进 .gitignore(每人的餐盒自己造,不入库)。

## 3. 跟着数据走:挑战头为什么不能脱

7 个测试里最微妙的是这条(参考项目的经典边界,照抄了场景):

```
WWW-Authenticate: Basic realm="api"
```

它长得几乎和凭据头一样,都有 `Basic`。但语义完全相反:**凭据头**(请求方发出)是"这是我的密码本,拿去";**挑战头**(服务器返回)是"请出示密码本"——它只声明认证方案,里面**根本没有秘密**。脱它 = 纯误伤。

我们的规则为什么天然挡住?`basic_auth` 正则要求字面 `Authorization\s*:\s*Basic`——挑战头里的单词是 `WWW-Authenticate`,`Authorization` 四个词根本不出现;`realm="api"` 的 `realm` 也不在 secret_assignment 的键名表里。**0 命中,原样放行**。测试把它锁死:以后谁把正则"放宽"成 `(?i)\bAuth\w*:\s*Basic`,这里立刻红。

## 4. 新技术点:pytest 回归测试

- **名字**:pytest,Python 事实标准的测试框架。
- **作用**:自动发现 `test_*.py` 里的 `test_*` 函数,逐个执行,断言失败即红。和手跑 `python main.py` 看输出的区别:**主输出的对错靠人眼判断,回归靠机器判断**——人眼会累会漏,`assert` 不会。
- **参数**:`-v` 显示每个用例名;`tests/` 指定目录;失败时 pytest 自动打印断言两侧的实际值(不用自己写 print)。
- **用法**:本项目 `tests/test_rules.py:39` 一例:

  ```python
  challenge = 'WWW-Authenticate: Basic realm="api"'
  assert sanitize(challenge) == (challenge, [])   # 文本不变 + 零命中,两个都要
  ```

  命名即文档:测试函数名直接写行为结论(`test_basic_auth_redacted_prose_and_challenge_not`),半年后不用点开就知道它在防什么。

## 5. 关键顿悟

- **负例分两档,回归只锁"必须干净"档。** 口令规范语言、干净业务日志 = 必须 0 命中,进回归;纳秒延迟 = **已知误报**,故意**不**进回归——它是引擎的诚实边界,阶段 10 要拿它算 precision,锁成"必须干净"反而撒谎。
- **测试是写给三个月后的自己的信。** 每个测试函数对应一个"差点写错"的边界(截断 PEM、带空格口令、挑战头),注释讲**为什么**这是边界——规则会换写法,边界不会换。
- **0.01 秒的回归是免费的保险。** 纯 stdlib 引擎的测试不用模型、不用网络,快到可以每次改动都跑——贵的是没有它之后的排查。

## 6. 亲手验证

```bash
cd /Users/divh/Downloads/安全评估agent/日志脱敏复刻
.venv/bin/python -m pytest tests/ -v
```

应看到:`collected 7 items` + 7 个 PASSED + `7 passed in 0.01s`。(若没建过环境,先跑 §2 的三条命令。)

捣乱实验:亲手体验"回归抓人"——把 `tests/test_rules.py` 最后一条测试的输入从 `"code=9138001380009"` 改成 `"call 13812345678"`(真手机号),再跑一遍:应看到 1 failed,断言输出里 `findings == []` 与实际命中不符。看完把测试改回来,绿灯恢复——**这个红灯就是回归的价值现场**。