# 62-register-contract-test: jiaotu-register 注册契约测试补齐（体检 #6）

**What to build:** `scripts/jiaotu-register.ts` 是跨仓契约面（POST /api/v1/agents 注册、GET /api/v1/agents?q= 查重、.env upsert），目前零测试（体检 #6：椒图侧 identity.test.ts:32-41 已锁，soc-demo 侧单侧裸奔）。补契约测试：fetchImpl 注入（脚本既有测试缝）捕获请求形态——①先查后建幂等：列表命中同名→不 POST、返回 created:false；未命中→POST body `{name,scope,owner}` 逐字段断言、201 `{agent_id,api_key}` 解包；②`upsertEnvKey` 三态（文件不存在新建/已有键整行替换/无键追加带注释行）用 tmp 目录；③网络不可达大声抛错带 URL 上下文。不真出网，先例 `services/agent/src/jiaotu/token-ports-jiaotu.test.ts` 的 mockFetch idiom。

**Touches modules:** `m9`

**Belongs to spec:** specs/modules.md（m9 卡）；测试落 `scripts/jiaotu-register.test.ts`

**Blocked by:** 无

**Status:** done（2026-09-12 子 agent 施工 + 主窗口验收：8 例全绿，agent 548→556+4s 只增不减）

**验收：**
- [x] 契约测试覆盖：幂等查重（命中/未命中）、POST body 逐字段、201 解包、不可达抛错
- [x] upsertEnvKey 三态断言（新建/替换/追加），tmp 目录无残留
- [x] 全量测试只增不减；lint/typecheck 绿

**实现记录：**
- 落位：`scripts/` 不在任何 vitest project 内（根 package.json 无 test script；pnpm-workspace 只收 services/*、packages/*、evals），按票面预案落 `services/agent/src/jiaotu/jiaotu-register.test.ts`（该目录 vitest 默认 include 直接收编），import 用相对路径 `../../../../scripts/jiaotu-register.js` 引 scripts 源；根 lint 范围含 services/ 故新文件被 lint 覆盖。
- 锁法照 `token-ports-jiaotu.test.ts` 的 mockFetch 出站捕获先例，fetchImpl 注入（脚本既有测试缝），零真出网；椒图侧口径对齐 `agentjiaotu/services/gateway/src/identity/identity.test.ts:32-41`（201 / `^agent_/` / `^ajt_/` / 重名不冲突唯一性在 agent_id）。8 个用例：
  1. 未命中：先 GET `/api/v1/agents?q=soc-demo` 再 POST，body `{name,scope,owner}` `toEqual` 一字不增不减（缺省 scope 三项「任务票申领/票据焚毁/LLM 出站」+ 缺省 owner）；201 `{agent_id,api_key}` 解包为 `{created:true, agentId, apiKeyOnce}`，且断言值匹配 `^agent_/` `^ajt_/`；列表只回子串同名（`soc-demo-62`）不算命中（客户端精确匹配 name 的口径锁死）。
  2. 命中同名：只发一次 GET 不 POST，返回 `{created:false, agentId}`、无 `apiKeyOnce`（不重吐 key）；name 带空格锁 `encodeURIComponent` 进 q。
  3. 同 name 二次注册走查重命中路径：请求序列恰为 `GET→POST→GET`、全程只 1 次 POST、第二把 key 不出现——椒图「重名不冲突」幂等承诺的回归锚。
  4. 网络不可达：fetchImpl reject → 抛错信息含完整 URL（`${base}/api/v1/agents?q=...`）与原始错误语义（`fetch failed`），不静默。
  5. 失败分支大声抛：GET 列表非 ok（500）→ 抛 `GET /api/v1/agents → HTTP 500` 且不进 POST；POST 非 201（用 200 冒充注册成功）→ 抛 `POST /api/v1/agents → HTTP 200`。
  6-8. `upsertEnvKey` 三态（`os.tmpdir()` mkdtemp + afterEach 递归清理，无残留）：文件不存在 → 新建含注释行；已有键 → 整行替换、其他行一字不动、不产生重复键行（全量内容逐字节断言）；无键 → 尾部追加注释行 + 键行，无尾换行时先补 glue 换行。
- 门禁：`pnpm lint` 绿；`pnpm typecheck` 绿；全量 `pnpm test` 绿且只增不减——services/agent 51→52 文件、548 passed +4 skipped → 556 passed +4 skipped。
