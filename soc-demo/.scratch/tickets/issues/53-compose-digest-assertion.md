# #53 · 默认栈官方镜像 digest 钉缺机器断言

- Status: open
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

- [ ] 新断言：compose 文本中所有 `image:` 行均含 `@sha256`，含 profiles 内服务
- [ ] 自证有效：临时摘一枚钉（override 或文本）→ 测试红 → 还原绿（结果记票，不留脏文件）
- [ ] agent 包全量测试绿、零删除
- [ ] `8-4.md` 文末追加备注（照 2-2.md 票 50 先例）："票 53 修复后默认栈封条有机断言"，原文正文零改动
- [ ] 不改 docker-compose.yml 本体（钉已存在，只是没人查）

## 实现记录

（待填）
