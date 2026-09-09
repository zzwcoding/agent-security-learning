# fixtures/guards/ —— guards 跨语言形状契约

**这是 py 生产侧与 TS 消费侧的共同「法律」**（票 32，体检对账三-16：guards 响应
形状此前只有 TS 消费端 `guards-client.ts` 的类型注记这一份手抄，没有机器锁）。
形态仿 `fixtures/tickets/`（票 02 先例）：契约数据只有这一份，两端测试各读各判。

## 清单

```
fixtures/guards/
├── README.md        ← 本文件：两端消费方式
└── contract.json    ← 机读契约：请求/响应键集、阈值、通道枚举、通道策略、样本
```

## 契约内容（细节以 contract.json 为准）

- `POST /scan/injection`：请求 `{text, channel}`；响应键集
  `{is_injection, score, scanner, action, hits, text}` **一字不增不减**。
- `threshold = 0.5`（score ≥ 阈值判注入）；`scanner = "PromptInjection"`。
- 通道枚举 `alert_field / user_input / kb / tool_output`；通道策略
  `block / block / strip / flag`；action 值域 `allow / block / strip / flag`——
  `fail_closed` 是 TS 客户端 fail-closed（INV-1）本地合成的，不是服务端值。
- `client_only` 节：TS 侧消费契约（读哪四个键、`blocked = is_injection &&
  action === "block"`）。

## 两端消费方式

- **py 生产侧**：`services/guards/test_guards_contract.py`——TestClient 真打
  HTTP 面，逐键断言响应形状/阈值/通道策略咬合契约。
- **TS 消费侧**：`services/agent/src/guards-contract.test.ts`——本地样例服务器
  按契约形状回样，断言 `scanInjection` 映射出的 `ScanDecision`；通道枚举对
  `guards-client.ts SCAN_CHANNELS` 运行时名单（票 31 数组推导类型先例）。

## 改契约的规矩

谁要改形状（加键/改键/改策略），先改 `contract.json`（提案），再两端代码跟上
（执行），两端测试全绿（通过）——跳过契约直接改代码，先红的那端就是提醒。
响应形状的消费方不止 agent（web 未来直读也可能），改形状属于跨语言事件。

攻击语料的**族级判定**锚不在这里，在 `../attack/injection-corpus.json`
（guards 与 mcp-audit 双引擎共享，见该文件 anchor_note）。
