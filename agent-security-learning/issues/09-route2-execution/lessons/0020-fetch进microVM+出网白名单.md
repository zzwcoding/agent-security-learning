# 0020 fetch 进 microVM + 出网白名单(阶段 23)

## 三问(阶段动机)

**终极目标**:Agent 就算被注入完全劫持,也伤不到宿主机、偷不到真密钥。

路线图:

```
✅ 阶段21:microVM 最小闭环跑通
✅ 阶段22:shell 工具搬进 microVM(攻击者的手被关进玻璃房)
👈 阶段23:fetch 进 microVM + 出网白名单(把任意门改成单行道)
⬜ 阶段24:Docker vs microVM 逃逸对比
⬜ 阶段26-27:凭证代理
```

**这一阶段是干嘛的?** 把 fetch 工具(http_get/http_post)从"宿主机裸发 HTTP"搬进一次性 microVM,并配上出网白名单——名单外的地址,请求根本发不出去。

**什么需求逼的?** 路线 1 的缺口 1:fetch 是 SSRF(服务端请求伪造)教具,注入得手后可以被诱导访问**任何能到达的地址**——内网路由器、云元数据端点(里面有云平台临时凭证)、或者干脆把偷到的密钥 POST 到攻击者的服务器。shell 进了玻璃房(阶段 22),fetch 还开着任意门,密钥外泄的路就没堵死。

**解决了什么麻烦?** 缺口 1 正式核销。现在的形态是两道闸:白名单外的域名,VM 都不会拉起(工具层,fail closed);内网 IP 和云元数据端点,就算攻击者在 VM 里裸跑任意代码也够不着(网络层,PUBLIC profile 默认拒私网)。

## 全链路一览

改造前(路线 1 形态):

```
模型说 http_get('http://192.168.1.1/路由器管理页')
   → MCP stdio 传给 fetch_server
   → httpx.get(宿主机发!)   ← 宿主机能到哪它就能到哪,完蛋
```

改造后(阶段 23):

```
模型说 http_get('某个 URL')
   → MCP stdio 传给 fetch_server
   → 白名单闸:scheme 必须 http/https,host 必须在名单内  ← 新增的闸,不过就拒绝
   → Sandbox.create(network=PUBLIC profile) 拉起一次性 microVM
   → VM 内 curl 执行请求
   → 状态码+响应体包好送回 → 经 MCP 回给模型
   → async with 结束,VM 销毁
```

注意:**工具名、参数、返回格式基本没变**(`HTTP 200\n{响应体}` 和原来一样)。模型和 Agent 主程序无感——和阶段 22 同一个思路:防御升级不需要模型配合。

## 跟着数据走:四个 URL 的命运

走真实 MCP 协议调了五次工具(全部通过,总耗时 3.5 秒):

1. **`https://httpbin.org/get`**(白名单内)→ 闸通过 → VM 开机(公网策略)→ curl → `HTTP 200` + 响应体
2. **`https://example.com`**(白名单外)→ 闸直接拒绝:`🛡️ 出网白名单拒绝:example.com 不在 ('httpbin.org',)`——**VM 都没拉起**,瞬间返回
3. **`http://192.168.1.1/`**(SSRF 经典目标)→ 同样被闸拒绝
4. **`file:///etc/passwd`**(换协议偷文件)→ scheme 闸拒绝:`只允许 http/https,收到 scheme=file`
5. **POST hello-from-microvm 到 httpbin.org/post** → 200,响应体里 `form` 字段原样回显

网络层兜底单独实证(在 VM 里**绕过工具层裸跑 curl**,模拟工具层被绕过的最坏情况):

```
curl http://192.168.1.1/        → exit 7 连接被拒
curl http://10.0.0.1/           → exit 7 连接被拒
curl http://169.254.169.254/... → exit 7 连接被拒(云元数据端点)
curl http://127.0.0.1:8080/     → exit 7 连接被拒
```

## 新技术点:microsandbox 网络策略,以及这次踩的 beta 大坑

- **名字**:`microsandbox.types` 的 `Network` / `NetworkPolicy` / `NetworkProfile` / `Destination`,通过 `Sandbox.create(network=...)` 挂载
- **作用**:给 VM 的出网装防火墙。三种现成形态:`Network.allow_all()`(全开,默认)、`Network.none()`(全关)、`Network.from_profiles(NetworkProfile.PUBLIC)`(只许公网,私网默认拒——本项目用这个)
- **参数**:`NetworkPolicy(default_egress=Action.DENY, rules=(...))` 可以自己拼规则;`deny_domains=("某个域名",)` 能在 DNS 解析(NXDOMAIN)/TLS 首包(SNI)/TCP 出网三层拦特定域名
- **用法**:本项目用在 `mcp_servers/fetch_server.py` 的 `_fetch()` 里,一行:`Network.from_profiles(NetworkProfile.PUBLIC)`

**踩坑实录(六轮探针,这是本阶段最值钱的经验)**:

我们本来想用文档里的规则拼"域名白名单":`NetworkPolicy(default_egress=DENY, rules=(Rule.allow_dns(), Rule.allow(destination=Destination.domain("httpbin.org"))))`——文档语义看起来天经地义。实测六轮探针(每次改一点规则形状,进 VM 看 DNS 和 curl 的真实表现):

| 策略形状 | VM 内 DNS | 结论 |
|---|---|---|
| custom + domain 白名单(原始方案) | 全死 | httpbin 自己都解析不了 |
| + 53 端口对网关 IP/CIDR 放行 | 还是死 | allow_dns 指的 host 组罩不住网关 |
| default_egress=ALLOW(全开) | 还是死 | 不是 deny 挡了 DNS |
| `from_profiles(PUBLIC)` | **活了** | 解析返回 198.18.x.x 假 IP——网关的 fake-IP DNS 代理 |
| custom + multicast 组放行 | 死 | 触发条件是 public 组,不是随便什么组 |
| deny(public)+allow(public) 混排 | 死 | 拼不出"先 domain 后 public"的白名单 |
| PUBLIC + `deny_domains` | 活且真拦 | 唯一能用的域名限制:黑名单,不是白名单 |

结论:0.6.16 的 fake-IP DNS 代理只在策略含 public 组放行时才启动,而它一启动公网就全开——**规则级域名白名单在这个版本拼不出来**。另外这台 Mac 的宿主 DNS 本身就是 fake-IP 代理(Clash 系),连"宿主机解析真 IP 再钉管道"的绕路方案都作废。最终定型:工具层白名单 + 网络层 PUBLIC 兜底。

## 关键顿悟

- **fail closed 的位置比强度更重要**:白名单闸放在拉起 VM **之前**,名单外的请求连一台 VM 的资源都不消耗(实测拒绝是瞬间的);要是放在 VM 里 curl 之后,就多了无数绕路。
- **beta 的坑要探针实证,不能信文档**:`Rule.allow(destination=Destination.domain(...))` 文档语义天经地义,实测六轮探针证明此路不通。每个"应该可以"都要配一个 exit code;探不动的记进 record,不硬撑。
- **分层防御是把"暂时做不到"兜住**:域名白名单暂时只能落在工具层(字符串层,理论可绕),但网络层把更致命的一半(内网/元数据)用 PUBLIC profile 兜死了。两层各挡一类,合起来缺口 1 才算核销。等 SDK 新版本修好 domain 规则,再把工具层那道闸下沉到网络层。
