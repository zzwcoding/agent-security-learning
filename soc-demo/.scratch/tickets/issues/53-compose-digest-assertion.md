# #53 · 默认栈官方镜像 digest 钉缺机器断言

- Status: done
- Priority: P3
- Discovered: 2026-09-10（场景 8 步 8.4 捣乱实验 B，教学导览发现）
- Modules: compose / CI

## 缺口解剖

位置：
- `soc-demo/docker-compose.yml:124/141/155` —— chroma / openfga / contextforge 三枚 `image:` 官方镜像钉（@sha256）
- `services/agent/src/compose-topology.test.ts:36-44` —— 钉断言只覆盖 langfuse 对与 wazuh-manager 三枚 profile 镜像

现象：override 文件把 chroma 的 `image` 摘成 `chromadb/chroma:latest` 后 `docker compose config -q` 照样通过（compose 语法闸不校验封条），拓扑测试也不红（它静态读 docker-compose.yml 文本，钉断言只写给了 langfuse/wazuh）——**默认栈三枚封条目前只有 compose 注释 + 评审纪律在守**。

对照：摘 langfuse 的钉拓扑测试当场红（8.4 捣乱 A 实测）——断言机制存在，覆盖面缺三枚。

## 修法（推荐）

`compose-topology.test.ts` 的钉断言**扩展为"凡 `image:` 行必匹配 @sha256"**（全量扫描 compose 文本的 image 行，一条规则管现在与未来，新加服务自动被覆盖），替代逐枚点名。不采用 CI compose-config job 加 grep 闸方案（断言留在测试里更贴近现有结构与失败提示）。

## 验收清单

- [x] 新断言：compose 文本中所有 `image:` 行均含 `@sha256`，含 profiles 内服务
- [x] 自证有效：临时摘一枚钉（override 或文本）→ 测试红 → 还原绿（结果记票，不留脏文件）
- [x] agent 包全量测试绿、零删除
- [x] `8-4.md` 文末追加备注（照 2-2.md 票 50 先例）："票 53 修复后默认栈封条有机断言"，原文正文零改动
- [x] 不改 docker-compose.yml 本体（钉已存在，只是没人查）

## 实现记录

（2026-09-10 落地）

**改动面**：仅 `services/agent/src/compose-topology.test.ts` 一处，纯追加（既有 16 断言一条未删未改）；`docker-compose.yml` 本体零改动（git checkout 自证后还原，工作区干净）。

**新规则怎么写**：文件末尾新增 `describe("票 53 静态拓扑：凡 image: 行必按 @sha256 digest 钉（全量扫描，含 profiles 内服务）")`，两个 test：

1. **总闸**：`composeText().split("\n")` 逐行编号，`/^\s*image:/` 过滤出全部 image 行（顶格 `#` 注释天然排除，profiles 内服务同扫）；对每行取 `image:\s*(\S+)` 的值 token，`/@sha256:[0-9a-f]{64}$/` 不中即入 offenders；断言 `expect(offenders, "封条总闸（票 53）：以下 image 行未按 @sha256 digest 钉").toEqual([])`——失败信息逐条点名 `docker-compose.yml:<行号>\t<该行内容>`。
2. **扫描非空**：`imageLines().length >= 1` 防空转（compose 被清空/路径解析错时总闸 vacuous pass 的护栏）。

旧断言与的关系：票 37/38 逐枚点名（langfuse 对 + wazuh-manager）保留——它们额外锁镜像名（`langfuse/langfuse`、`wazuh/wazuh-manager`）与"不 build"，总闸只管"凡 image 必钉"，两层互补。

**自证证据（改文件法，git checkout 还原）**：

- 原样：`src/compose-topology.test.ts` 18/18 绿（16 旧 + 2 新；docker daemon 在场，compose config 语义断言实跑）。
- 摘钉：sed 把 `docker-compose.yml:124` 的 chroma 钉换成 `chromadb/chroma:latest` → `1 failed | 17 passed`，失败输出正中总闸：
  ```
  AssertionError: 封条总闸（票 53）：以下 image 行未按 @sha256 digest 钉:
  - []  + [ "docker-compose.yml:124\timage: chromadb/chroma:latest" ]
  ```
  同跑中票 37/38 旧断言与 compose config 语义断言全过（chroma 服务名册不动、config 照过）——8.4 捣乱 B 的"无人红"窗口由总闸单独闭合，对照结构成立。
- 还原：`git checkout -- soc-demo/docker-compose.yml`（授权动作）→ 钉回 :124 → 18/18 绿；`git status` 仅余本测试文件改动。

**测试数字**：基线 492 passed | 3 skipped（495）→ 现 494 passed | 3 skipped（497），48 文件，只增 2 不减。备查：全量跑中 `workers/triage/accuracy.test.ts` 的"注入变体"横断测试出现过一次 5000ms 超时（单跑 14/14 绿、相邻两轮全量均绿）——该用例常态耗时 ~4.8s 贴着超时线，属既有 flaky，与本票无涉，不另开票。

**文档**：`8-4.md` 文末追加备注（照 2-2.md 票 50 先例，正文零改动）；`00-导览总纲.md` 学习日志 +1 条修复记录、"发现的问题" #53 条目回填"已修复"。
