# #56 · 192.168 段内网 IP 脱敏时被误标为 PHONE_NUMBER

- Status: done（2026-09-10，guards 容器已重建，live 终验内网存活/公网照脱入账）
- Priority: P3
- Discovered: 2026-09-10（场景 6 步 6.1 捣乱实验 B，教学导览发现）
- Modules: guards

## 缺口解剖

位置：`services/guards/pii.py:44-46` —— `Rfc1918ExemptIpRecognizer.analyze` 只过滤**自家 IpRecognizer** 的结果；Presidio 内建 PhoneRecognizer（score 0.4）对 `192.168.1.100` 点分隔凑出 3-3-4 电话形态抢命中，且分数高于自家 IpRecognizer，overlap 裁决时把内网 IP 顶掉。

现象：RFC1918 三段中 `10.x`、`172.16-31.x` 存活，唯独 `192.168.1.100` 被替换成 `<PHONE_NUMBER>`，原文（带前导空格）还进了 mapstore —— 违背决策 #8"内网 IP 是资产标识不脱"口径。

## 修法（推荐：方案 a，豁免上移）

anonymize 主函数在 `_drop_overlaps` 之后对**最终实体清单**再过一遍 RFC1918 过滤（把豁免从"识别器内部"上移到"清单层"）——正交于任何识别器的抢座行为，未来换/加识别器也不会复发。不采用负向前瞻改电话识别器方案（依赖识别器内部实现，脆）。

配套：补测试覆盖 `10.x / 172.16-31.x / 192.168.x` 三段全存活 + `198.51.100.x`（公网）仍正常脱敏。

## 验收清单

- [x] `192.168.1.100` 在 anonymize 输出中原样存活（不再变 `<PHONE_NUMBER>`）
- [x] RFC1918 三段 + 公网对照的四用例测试绿
- [x] guards 包 pytest 全绿、零删除
- [x] mapstore 不再收入内网 IP 原文（可用既有教具探针复验一次并记票）
- [x] `6-1.md` 文末追加备注（照 2-2.md 票 50 先例）："票 56 修复后捣乱 B 三段全存活"，原文正文零改动
- [x] 改动最小化：只动 pii.py 的豁免逻辑 + 测试，不碰识别器注册结构

## 实现记录（2026-09-10，修复执行子 agent）

**方案 a 落地（豁免上移清单层）**：`services/guards/pii.py` 的 `anonymize` 在 `_drop_overlaps` 之后、mapstore `record` 之前插一行过滤——`results = [r for r in results if not RFC1918.match(text[r.start:r.end])]`，配四行注释交代动机。要点：

- **过滤不问 entity_type，只看 span 切片是否锚定全文命中 RFC1918**——正交性正是修法本意：抢座的可以是 PhoneRecognizer（本案）或未来任何识别器，只要最终清单里坐着"整段是内网 IP"的结果就作废；
- **锚定全文匹配（`^…$`）防误伤**：公网 `110.0.0.5` 这类前缀陷阱不会被无锚点子串匹配误豁免——识别器给出的 span 是完整 `110.0.0.5`，锚定正则不命中，照脱；
- **插在 `record` 之前**：内网 IP 原文从此没有进 mapstore 的路径（验收 4 的结构性保证，不是事后清库）；
- 识别器注册结构零改动：`Rfc1918ExemptIpRecognizer` 原样保留（自家豁免仍是第一道，清单层是兜底第二道），`_drop_overlaps`、mapstore、响应形状（票 32 锁）全部不动。

**新增测试**（`services/guards/test_guards.py`，插在既有 `test_rfc1918_internal_ip_exempt_public_masked` 之后，零删除）：

- `test_rfc1918_three_ranges_survive_phone_seat_steal_ticket56`——四用例一段文：`10.20.30.40` / `172.31.99.5` / `192.168.1.100` 三段内网全存活 + 出口 `198.51.100.7` 照脱（唯一 IP 实体断言 span 切片 = 公网地址）；另断言输出无 `<PHONE_NUMBER>`（抢到座的也被清单层拦下）。既有同款用例的 192.168 样本是短尾 `192.168.1.1`，恰好躲开 3-3-4 电话形态，故复现不了本票——新用例用带长尾的 `192.168.1.100` 补上这个盲区；
- `test_internal_ip_original_never_enters_mapstore_ticket56`——脱敏后走 `/pii/reveal` 逐个占位符查账：五个占位符账面 originals 只有真手机 `13812345678`（对照组照收），无任何 `192.168.` 原文入账。

**测试与复验数字**：修复前基线 `cd soc-demo/services/guards && python -m pytest` → **26 passed**（照票 52 口径）；修复后同命令 → **28 passed，只增不减**（+2 新增用例，既有零删除零改动）；ruff（票 52 钉定版 0.16.6）`check services/guards` → All checks passed。修复前后各跑一遍匿名探针：修前 `192.168.1.100 → <PHONE_NUMBER>`（复现确认），修后原样存活、`10.0.0.5`/`172.16.3.20` 照旧存活、`8.8.8.8`/`198.51.100.7` 照脱。

**mapstore 复验（如实口径）**：guards 容器 `docker inspect` 只 bind mount `/app/data`，源码烤镜像——live 端点口径做不了（restart 吃不到修复，重建超本票授权），按预案降为**本地函数级复验**：anonymize 一发内网 IP 后查同进程 store 无该原文新增行（上述新测试即此口径的常驻版本，PII_MAPSTORE_PATH 指向隔离 tmp 库，零污染）。宿主侧只读核对（`sqlite3 "file:…?mode=ro"`）：生产 mapstore 仍 11 行，教具行 `<PHONE_NUMBER>|' 192.168.1.100'`（6.1 捣乱 B 留档）原样在库未动。

**交接（主窗口）**：跑一次 `docker compose build guards && docker compose up -d guards` 让镜像吃进修复，再对 guards `:8002`（或既有容器内探针 ③）打一发 `192.168.1.100` 即完成 live 口径终验；mapstore 行数核对（应仍 11 行、无误标新增）可顺手复点。Docker 本票零操作（容器全程 healthy 未动）；git 零写操作，待主窗口验收后统一提交。

改动面：`services/guards/pii.py`（+5）、`services/guards/test_guards.py`（+30）；另有授权内文档回填：`6-1.md` 文末备注、`00-导览总纲.md` 学习日志 +1 条与"发现的问题"#56 条目回填。
