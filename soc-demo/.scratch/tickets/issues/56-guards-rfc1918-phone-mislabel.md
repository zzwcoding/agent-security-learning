# #56 · 192.168 段内网 IP 脱敏时被误标为 PHONE_NUMBER

- Status: open
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

- [ ] `192.168.1.100` 在 anonymize 输出中原样存活（不再变 `<PHONE_NUMBER>`）
- [ ] RFC1918 三段 + 公网对照的四用例测试绿
- [ ] guards 包 pytest 全绿、零删除
- [ ] mapstore 不再收入内网 IP 原文（可用既有教具探针复验一次并记票）
- [ ] `6-1.md` 文末追加备注（照 2-2.md 票 50 先例）："票 56 修复后捣乱 B 三段全存活"，原文正文零改动
- [ ] 改动最小化：只动 pii.py 的豁免逻辑 + 测试，不碰识别器注册结构

## 实现记录

（待填）
