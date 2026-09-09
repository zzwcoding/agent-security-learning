# 49-m9-pii-mapstore: PII mapstore 落地 + 受控反查口（ADR 0004-3）

**What to build:** guards /pii/anonymize 脱敏时记录 占位符→原文 映射（guards 自持 sqlite 落盘，.gitignore 覆盖数据目录）；新增受控反查链路：web（duty_lead/admin）→ agent 过闸端点 → guards /pii/reveal（占位符→原文），全链 INV-8 审计；映射表属敏感面不进任何日志/事件可观测面。

**Blocked by:** （ADR 0004 已落）

**Touches modules:** `m2`, `m9`, `m10`

**Belongs to spec:** specs/modules.md

**Status:** done

- [x] 脱敏产出映射落盘，重启不丢（源：FR-S4.2·遗留 [24-1]·ADR 0004-3）
- [x] 反查链路角色受控：soc1/redteam 不可用，duty_lead/admin 可用；每查必审计（源：A.2 矩阵·INV-8）
- [x] 映射表内容不出现在日志/SSE/审计 details（金丝雀式断言）（源：敏感面口径·INV-4 类推）
- [x] 投影图 guards-internal 的「脱敏映射表」幽灵节点变事实（源：收尾体检 [四-5]）

## 实现记录（2026-09-10）

**落点**：
- `services/guards/pii_store.py`（新）：mapstore 本体。自持 sqlite（`data/pii-mapstore.sqlite`，env `PII_MAPSTORE_PATH` 覆盖=测试接缝；`reset_store()` 兼任"重启"测试原语）；表 `pii_map(placeholder, original, entity_type, first_seen)`，PRIMARY KEY (placeholder, original) 去重。
- `services/guards/pii.py`：anonymize 在替换前按实体 span 切原文，把 占位符→原文 对旁路 `record()` 进库；落盘失败异常炸出（fail-closed——脱敏不留映射=反查口开空头支票）。
- `services/guards/app.py`：新增 `POST /pii/reveal {"placeholder"}` → `{"placeholder","originals","count"}`；缺参 400 / 查无此人 404（`{"error": code}` 全仓同款）。角色闸不在这层——反查是人的动作不是工具调用。
- `services/guards/conftest.py`（新）：autouse 把每条用例的 mapstore 指到独立 tmp_path，既有测试（票 04/24/32）一行不改回到隔离库。
- `services/agent/src/guards-client.ts`：`revealPii(placeholder, opts)` 出站客户端——超时/错误分类收 outbound.ts（`guards_timeout`/`guards_unreachable`），404→`placeholder_unknown`，任何失败收口 `{ok:false, reason}`（INV-1 fail-closed）。
- `services/agent/src/app.ts`：`POST /api/v1/pii/reveal`（会话验签 → 角色白名单 → 转发 guards）。`buildApp` 增 `revealPii` seam（缺省 HTTP 件）。审计 `action:"pii_reveal"`/`objectType:"pii_placeholder"`，SUCCESS/FAILURE/DENIED 三路全记（每查必审计含被拒的查），SUCCESS 的 details 只有 `{match_count}`——原文一个字节不进。
- `services/web/src/reveal.ts`（新）+ `api.ts revealPii()` + `pages/CasePage.tsx`：时间线条目文本检测到 `<TYPE>` 占位符且角色 ∈ {duty_lead, admin} 才出「反查 PII」按钮（可见性即第一收窄，检测驱动不猜）；点击带会话 Bearer 反查，结果就地渲染 `<EMAIL_ADDRESS> → 原文`；401/403/404/502 各有人话。
- 装配：guards Dockerfile COPY 补 `pii_store.py`；compose guards 挂 `./data/guards:/app/data`（票 41 卷口径——挂这里库文件才真落宿主盘）。

**容器冒烟**（真 compose 件）：`docker compose build guards && up -d` → anonymize 打进映射 → `POST /pii/reveal` 返回原文 → `docker compose restart guards` 后再 reveal **原文还在**（宿主 `data/guards/pii-mapstore.sqlite` 落盘生效）→ 未知占位符 404。

**测试（TDD 先红后绿，零删除）**：guards `test_pii_mapstore.py` 7 条（记映射可反查/重开库不丢/同占位符多原文列表+去重/404/400/anonymize 响应键集一尘不动/库文件落点）；agent `pii-reveal.test.ts` 8 条（duty_lead+admin 可用+SUCCESS 审计/soc1+redteam 403+DENIED 审计/401+400+503/404+FAILURE/502+FAILURE/金丝雀——三路全走一遍审计序列化 grep 不到原文/revealPii 出站 200·404·500·不可达）；web `reveal.test.ts` 6 条 + CasePage 2 条（duty_lead 见按钮+点击带 Bearer 反查就地显原文、普通条目不出按钮；soc1 不见按钮）。

**门禁**：`check_specs.py` PASS（0 警告）；`check:boundary` PASS（self-test 18/18，0 越界）；`pnpm lint`/`pnpm typecheck` 过；guards ruff 过（仅本票 py 文件）。测试基线：agent 482+4sk（基线 474+4sk+8）/ case-backend 60 / evals 99 + eval runner 33 用例 / ingest 41+1sk（wazuh 真容器冒烟能力探测 skip，票 48 同口径，本票零 ingest 改动）/ web 108（基线 100+8）/ mcp-audit 14 / guards pytest 26（基线 19+7）/ gateway 43。

### 记票定夺（票面留白处 / 交 L0 备案）

1. **「PII 反查」的 A.2 归属 = 方案 a（端点级角色白名单），不改矩阵**：反查是「人」的动作不是 worker 工具调用（`Pii_reveal` 不在任何票面 allowedTools 里，不走 verifyTicket/FGA 工具闸）；闸落在 agent 端点：登录会话（HMAC，与 /chat 同门）+ `PII_REVEAL_ROLES = {duty_lead, admin}` 白名单。A.2 四族矩阵未动，web 侧名单是它的镜像（一致性靠两边测试锚定，票 39 记票④先例）。**请 L0 追认此归属**。
2. **占位符不编号，同占位符多原文以列表全收**：wire 占位符保持 `<TYPE>`（FR-S4.1 契约与既有契约测试不动）；同一文本同类型多实体替换后占位符同名，映射表按 (placeholder, original) 去重全收，反查返回首见序全部原文。反查结果的「占位符→原文」在多原文时是一对多，演示时逐条列出。
3. **FR-S4.2 文字与本票的裁决关系**：PRD FR-S4.2 原文「映射表仅服务端内存保留、run 结束即弃；不进审计」——ADR 0004 裁决 3 已改判前半句（落盘+受控反查）；后半句「不进审计」落实为敏感面口径：审计记「谁查了占位符 X、命中几条」，不记查回的原文（金丝雀断言在 agent 侧测试）。PRD 文字修订留待下次 PRD 修订（本票不改正文交付物）。
4. **anonymize 在 TS 链路仍无消费方（承接票 24 记录①的另一半）**：本票把 mapstore+反查口做成事实，但「哪条 worker 链路在出域前调 anonymize」仍无接线（全仓 grep 无 TS 调用方）——脱敏出域链路的接线是独立工作，不在本票范围；web 反查按钮因此是"检测到占位符才出现"（案件时间线现无占位符数据时按钮不出现，演示可先 curl guards 造映射 + 时间线条目带占位符）。
5. **guards「无状态」投影标注未全局清洗**：guards-internal 投影里 mapstore 节点已变事实（sublabel「自持 sqlite · 重启不丢」、tag「敏感面 · 不进日志/审计」、新增 api→mapstore 受控反查边），但节点 context 横幅「C4 · Python FastAPI · 无状态」是全图统一文案，未逐字改（改它要动全图十几个节点，收益低）——服务壳仍无状态，状态收敛在 mapstore 一处。
6. **py 侧 import 排序**：ruff isort 对 guards 既有 test 文件的既有 import 顺序会报 I001（基线本就不净）——本票只保证自己新增/改动的 py 文件 ruff 干净，不顺手清洗他文件（避并行冲突）。
