# 0023 凭证代理 fetch 路(阶段 27)

## 三问(阶段动机)

**终极目标**:Agent 就算被注入完全劫持,也伤不到宿主机、偷不到任何真密钥。

路线图:

```
✅ 阶段21-23:执行面进 microVM + 出网白名单
✅ 阶段24-25:边界对比 / 自修改 agent 复刻(平行窗口)
✅ 阶段26:凭证代理 LLM 路(真 key 撤出 Agent 进程)
👈 阶段27:凭证代理 fetch 路({{SECRET:NAME}} 占位符分发)
⬜ 阶段28-29:脱敏 + 审计    ⬜ 阶段31:四次攻击验收
```

**这一阶段是干嘛的?** 让 Agent 调用需要鉴权的外部 API 时,请求里写 `{{SECRET:NAME}}` 占位符,真值由策略表在分发瞬间从 Keychain 换入——Agent 和模型从头到尾只见过占位符。

**什么需求逼的?** 阶段 26 撤走了 LLM 的 key,但"密钥随请求出网"这条路还开着:模型只要在工具参数里写出真值(比如从记忆/上下文里骗到的 token),它就会原样发出去。反过来,模型也永远不需要见到真值——占位符是它唯一该写的东西。

**解决了什么麻烦?** "用密钥"和"持有密钥"从此分离:模型负责"要用哪个密钥"(写名字),策略表负责"给不给、给谁"(域名授权),Keychain 负责"值是什么"。三件事拆给三个组件,谁也不多拿。

## 全链路一览

```
模型生成工具参数: http_post("https://httpbin.org/post", "token={{SECRET:DEMO_API_KEY}}")
   → MCP stdio → fetch_server
   → 白名单闸:域名在 ALLOWED_DOMAINS?              (阶段 23)
   → 凭证闸:DEMO_API_KEY 在 CREDENTIAL_POLICY[httpbin.org] 点过名?
   → Keychain 现取真值,替换占位符(最后一刻注入)
   → 一次性 microVM 里 curl 发出                    (阶段 23,网络层兜底)
   → httpbin 回显:{"form": {"token": "demo-sk-1234..."}}  ← 真值只存在于这条出网请求里
```

注意:策略表和出网白名单在**同一个文件、同一个闸的序列里**——域名能不能去(白名单)+ 去时能带什么(凭证表),这就是路线 3"MCP 网关"的思想预演。

## 跟着数据走:三个请求的命运

1. **合法占位符**:`token={{SECRET:DEMO_API_KEY}}` → 名字在 httpbin.org 的授权名单里 → Keychain 取到真值 → httpbin 回显 `{"token": "demo-sk-1234567890abcdef"}`——真值确实到了远端,而 Agent 进程的 env、内存、对话上下文里自始至终只有占位符
2. **未授权名**:`{{SECRET:OTHER_KEY}}` → 策略检查在 Keychain 查询**之前**,直接拒:`密钥 OTHER_KEY 未授权给域名 httpbin.org(fail closed,请求未发出)`——顺带不泄露"Keychain 里到底有哪些密钥"
3. **普通请求回归**:不带占位符 → 照常 200,白名单逻辑不受影响

CLI 真实链路实测:`/call http_post {...}` 走 Agent 进程 → 同样回显真值,四秒内完成。

## 新技术点:最后一刻注入(last responsible moment)

- **名字**:凭证分发 / placeholder injection,安全工程里的标准模式(参考项目 chapter9 的 SecretEntry 同款思想)
- **作用**:密钥的存在时间压到最短——只在"即将发出去的那条请求"里存在,替换完马上随请求走,不进环境变量、不进文件、不进模型上下文
- **关键参数/约束**:①策略检查必须**先于**取值(未授权的名字连 Keychain 都不查);②值用 subprocess 从 `security find-generic-password -s <NAME> -w` 现取,用完即弃
- **本项目位置**:`mcp_servers/fetch_server.py` 的 `CREDENTIAL_POLICY` 表 + `_resolve_secrets()`

**为什么注入点在 fetch_server 而不是 proxy.py?** 交接原案是"由代理替换",但阶段 23 实测过:fetch 的 curl 在 microVM 里发,VM 出网过不了宿主代理(自定义策略会弄死 DNS 代理)。fetch_server 本来就是"模型外的分发进程",且白名单就在它手里——策略表与白名单同处,正好符合设计原文。LLM 路没有这个问题,真 key 留在 proxy.py。

## 关键顿悟

- **拆权限比藏密钥更可靠**:模型拿"名字",策略表拿"决定权",Keychain 拿"值"。模型被骗只会写出一个名字,而名字过不了策略表。
- **fail closed 要在取值之前**:先查授权、再查存在性——调用方探不出"哪些密钥存在",这本身就是信息不泄露。
- **子进程会继承环境,环境就是泄密通道**:fetch_server 作为 Agent 子进程,任何塞进 Agent 环境的"密钥"它都看得见——所以密钥值的通道只能选 Keychain 现取,不能选环境变量。
