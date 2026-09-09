# 32-m9-guards-shape-lock: guards 跨语言形状锁 + 注入语料共享锚（D2）

**What to build:** ① fixtures/guards 契约（响应形状 is_injection/score/scanner/action + 通道枚举 alert_field/user_input/kb/tool_output）py/TS 两端测试共读，仿 fixtures/tickets 先例；② fixtures/attack/injection-corpus.json（族→样本→期望命中）共享语料，guards(llm-guard 主路径) 与 mcp-audit(rules.ts) 两套测试同读，锁「同族判定一致」而非合并实现（决策 #11 保持）。

**Blocked by:** （无）

**Touches modules:** `m9`, `m12`

**Belongs to spec:** specs/modules.md

**Status:** ready-for-agent

- [ ] guards 响应形状跨语言契约测试（源：对账三-16）
- [ ] 注入语料共享锚：两套引擎对同语料族判定一致（源：结构-10）
- [ ] 决策 #11（CLI 不依赖运行时 guards）不被破坏（源：PRD 决策记录 #11）
