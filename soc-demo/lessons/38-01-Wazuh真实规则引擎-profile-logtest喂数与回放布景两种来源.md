# 38-01 · 票 38：Wazuh 真实规则引擎——profile 请真法官，logtest 喂数与回放布景两种来源

## 三问

- **终极目标**：soc-demo 是能拿去汇报的 SOC 数字员工。它的告警接入弦（m1）到今天为止
  一直是「手造 fixture 直接推 webhook」——日志是我们写的，规则命中也是我们写死的，
  相当于**法医自己写案卷再自己签字**。本票给布景间请来一位**真法官**：Wazuh 的规则
  引擎，让同一段原始日志被它重新判一次。
- **为什么现在做**：PRD FR-M1.6 早写了「可选 docker-compose profile 起 Wazuh manager，
  `PUT /logtest` 喂真实日志产告警」。收官体检（checkup 2026-09-09）对账一-8 把它标成
  B2/P1：**PRD 承诺了，仓库里既没实现也没裁决砍掉**——承诺悬空。票 37 兑现了 Langfuse
  的同类欠账，本票照同一条路再兑现一张。
- **解决什么麻烦**：手造 fixture 是「照着答案出题」——我们说它是告警它才是告警，引擎
  的真实门槛（比如 5712 暴力破解要同会话 8 次以上才升档）从没真正拦过我们。真引擎把
  **判定权交回去**：同一段日志原料，引擎说 `alert=true` 才算告警，说 false 就 skip。
  汇报时「我们用真实 Wazuh 引擎回放验证过规则面」和「我们手写了假告警」是两个档次
  的回答。

路线图位置：收官体检转来的补齐票（B 组）第二张，m1 告警接入弦的「真实模式」一角。
票 37 的 observability profile 教会了我们 compose profile 这把开关，本票是同一把开关
的第二次使用 + 一个全新的 API。

## 全链路一览

```
（默认：什么都没有——九服务照旧跑，下面整套不存在）

开 profile 后：
fixtures/alerts/*.json（手造 fixture 只当「原料」）
   │ wazuh-logtest-feed.ts 读出 full_log 原文（宿主侧 CLI，不进 compose）
   ▼
① POST /security/user/authenticate（Basic：账号+密码）→ 换回一张 JWT 通行证
② PUT /logtest {event, log_format, location}（Bearer：带上通行证）
   ▼
wazuh-manager 容器（宿主 15500 → 容器 55000，profile real-wazuh）
   │ ossec-analysisd 真规则引擎现场判卷：这条日志会不会出告警？
   ▼
真回包 output（真实 rule.id / level / description / mitre / decoder…）
   │ alert=false 或没有 rule.id → 打一行 skipped_no_alert，不往下走
   ▼
POST ingest /api/v1/webhooks/alerts（正门，回包原样，绝不直塞数据库）
   ▼
ingest 老三样：校验 → 去重 → 映射（level→severity、mitre→tags）→ 写 case-backend
```

每个环节一句话：feed 脚本是**送卷员**（只送卷，不替法官判）；`/logtest` 是**试答
通道**（判卷但不生成正式成绩单）；wazuh-manager 是**只在选修课开门的法官席**；
webhook 正门是**收发室**——不管告警是 replay 手造的还是引擎真判的，都从同一扇门进。

## 跟着数据走：一条 ssh 登录失败日志的真实判卷

1. 原料：`fixtures/alerts/ssh-5710-bad-user.json`，里面 `full_log` 是一行真 sshd 日志
   `…Failed none for invalid user oracle…`，`location` 是 `/var/log/secure`。注意：
   手造 fixture 里还写着 `"id": "5710"`——喂真引擎时**这一栏被扔掉**，只带原文去。
2. 送卷员打包：脚本抽出 `full_log` 原文，装成 `{event: 原文, log_format: "syslog",
   location: "/var/log/secure"}`。`location` 很关键：引擎靠它选解码器上下文（sshd
   日志得从 secure 日志的上下文里解，换了 location 同一段文字可能解不出来）。
3. 先领通行证：`POST /security/user/authenticate`，Basic 认证（compose 里那对教学假
   账号），拿回 `data.token`——之后每次 `PUT /logtest` 都在头上带 `Bearer <token>`。
4. 法官判卷：真引擎回 `alert: true`，`rule.id: "5710"`，`level: 5`，description
   「sshd: Attempt to login using a non-existent user」，MITRE `T1110.001`（Password
   Guessing）——**这些全是引擎自己查规则文件得出的，不是我们填的**。
5. 回推正门：`alert=true` 且有 `rule.id` 才有资格回推。整个 `output`（就是 Wazuh 真跑
   时会写进 alerts.json 的那个告警 JSON）原样 `POST /api/v1/webhooks/alerts`，回 201
   带 `alert_id`。
6. ingest 翻译：level 5 落进 PRD §5.1 映射表的 5-9 档 → severity 2，`mitre:T1110.001`
   生成 tag，`wazuh:5710` 做 source 去重键——和 replay 进来的告警走**完全相同**的
   后半程。

**捣乱输入**：把手造 fixture 换成引擎判不出告警的（目录里一半 fixture 是这样）——
引擎回 `alert=false`，脚本打印 `skipped_no_alert`，**一行都不往 webhook 推**。测试
断言也按这个口径写：只要求 ssh 家族至少命中 2 条，不钉死 12 条全推——手造 fixture
本来就不是每条都能够到真引擎的告警阈值（5712 要 8 次以上才升档，单条喂进去真法官
只给 5710/5711 的低档）。

## 新技术点四要素：Wazuh logtest API

- **名字**：Wazuh logtest，Wazuh manager REST API 的 `PUT /logtest` 端点（Wazuh 4.x
  自带，和引擎同进程，不用额外装东西）。
- **作用**：把一条日志塞给真规则引擎「试跑」：不落盘、不改规则、不产生正式告警，
  立刻回「引擎会怎么判」。比喻：**阅卷试答器**——把答卷塞进去马上知道老师会打几分，
  但成绩单不生效。这正好解决「想用真引擎又不想真部署 agent 收日志」的演示困境。
- **参数**：请求体三必填——`event`（日志原文一行）、`log_format`（`syslog` 或
  `json`）、`location`（决定用哪套解码器，等于告诉法官「这是从哪份卷宗里抽出来的」）。
  认证两段式：`POST /security/user/authenticate` 用 Basic 换 JWT，之后 Bearer。
  响应里 `data.alert` 是「会不会出告警」的布尔，`data.output` 就是完整告警 JSON。
- **用法**：最小 curl 两步：

```bash
TOKEN=$(curl -sk -u wazuh-wui:'MyS3cr37P450r.*-' -X POST \
  https://127.0.0.1:15500/security/user/authenticate | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['token'])")
curl -sk -X PUT https://127.0.0.1:15500/logtest -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"event":"…sshd 日志原文…","log_format":"syslog","location":"/var/log/secure"}'
```

  本项目落在 `scripts/wazuh-logtest-feed.ts`（login 第 94 行起、runLogtest 第 110 行
  起）。https 自签证书用 `node:https` 的 `rejectUnauthorized:false` 关校验——本地教学
  容器专用，也是全脚本唯一一处不用 fetch 的出站（fetch 关不掉自签校验）。

## 关键顿悟

- **fixture 从「答案」降级成「原料」**：replay 模式里 fixture 连 rule.id 都是手造的，
  等于自带答案；喂数模式里只取 `full_log` 原文，规则命中让引擎现场重判。同一批原料、
  两种来源的布景——「回放布景两种来源」说的就是这个，而且**后半程（webhook→去重→
  映射→入库）一条不差共用**，来源不同只影响入口之前的半段。
- **诚实纪律：skip 不硬造**：引擎说 `alert=false` 就不推，测试也只断言「ssh 家族
  ≥2 条命中」而不钉死全推。让真引擎当法官的整个意义就在「它可以说不」——如果我们
  顺手把 false 也推过去，就等于又把答案塞回了法官手里。
- **可选件现在是三层开关**：票 37 学了 profile（编译期：容器起不起）；本票叠上去——
  容器起了**还得人跑 `pnpm wazuh:feed` 才有数据流**（推模式铁律②），manager 起着
  也不产生任何告警。这三层（profile 开关 → 手动喂数 → webhook 正门）让「真引擎」
  在演示里永远安全：不跑脚本它就是一台静默的法官席。
- **道具不进片场**：wazuh-manager 是布景（进 compose），喂数脚本是道具（永远宿主侧
  CLI，`docker-compose.yml` 里有机器断言保证它绝不出现）。和 replay.ts、票 37 的
  冒烟脚本同一纪律：非运行时件不进 compose。

## 亲手验证

```bash
cd /Users/divh/Downloads/安全评估agent/soc-demo
docker compose config --services | grep wazuh      # 不开 profile：应无输出（默认栈没有它）
docker compose --profile real-wazuh up -d wazuh-manager
docker compose --profile real-wazuh ps             # 应见 wazuh-manager Up，15500->55000
# 等 API 就绪（探针口径：未带凭证时应回 401 而不是连不上）：
curl -sk -o /dev/null -w '%{http_code}\n' -X POST https://127.0.0.1:15500/security/user/authenticate
                                                   # 应打印 401
pnpm wazuh:feed --only ssh-5710                    # 需默认栈起着（ingest 在 3001，见 README 启动节）
# 应见一行：ssh-5710-bad-user.json -> rule=5710 level=5 -> webhook 201 alert_id=…
docker compose --profile real-wazuh stop wazuh-manager   # 用完即停（logtest 无状态，重跑幂等）
```

**捣乱实验**：先 `pnpm wazuh:feed --dry-run --only ssh-5710`——零出网，只打印将发的
logtest 请求体（`event` 应是 fixture 的 full_log 原文）；再把某 fixture 的
`full_log` 改成一段无害日志（比如普通 cron 行）真喂一次——应见
`skipped_no_alert`，ingest 侧不产生新告警。
