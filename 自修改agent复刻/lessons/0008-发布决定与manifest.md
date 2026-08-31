# 0008 - 阶段 8:发布决定与 manifest——决定在模型外,证据要落盘

## 1. 三问(这一阶段是干嘛的)

**位置感**:

```
✅ 1-7 看病→确诊→开药→安检→沙箱→七项行为检查(十格灯表全绿)
✅ 8 放行决定 + manifest                          ← 你在这里
⬜ 9 可信根自证(SHA-256)
⬜ 10 真实 LLM 提案(MiniMax)
⬜ 11 验收入口:负对照必拒 + 三方同门槛
⬜ 12 对照收官:加固 Docker vs microVM
```

**这一步是干嘛的?** 灯表全绿之后,**由谁、按什么规则、说"可以上"**?答案:`release_manifest()` 这段确定性代码,规则一行就能写完——`accepted = 候选有实际改动 and 所有检查全绿`。全绿 → `release_to_canary`(进灰度);任何一个不满足 → `reject_candidate`。决定连同全部证据写进 `output/release_manifest.json`。

**什么需求逼的?** 如果"能不能发布"由生成补丁的一方(现在是确定性代码,阶段 10 起是 LLM)自己顺口说了算,那验证体系就是个摆设——考生自己给自己打分。所以发布决定必须是**模型外的独立代码**,而且它不能只吐一句"行/不行",得把**判定的全部依据**存档:改了什么(diff)、是谁生成的(provenance)、检查结果如何、落选原因是什么。

**解决了什么麻烦?** 把发布从"拍板"变成"查表":同一个候选,谁来跑都是同一个决定;事后任何人(审计者、未来的你)拿着 manifest 就能复核这个决定,不需要重跑整个流程。同时"决定只到 canary"把**上线半径**钉死——灰度影子流量,stable 原样不动,回滚触发条件预先写死在 manifest 里。

## 2. 全链路一览

```
diagnosis(阶段2) ──┐
candidate(阶段3/8打包) ──┼─→ release_manifest() ─→ decision: release_to_canary / reject_candidate
checks(阶段4-7灯表) ──┘        │
                              ▼
              output/release_manifest.json(好候选)
              output/rejected_manifest.json(捣乱候选)
              字段:失败簇/根因/diff/三方哈希/patch_size/checks/
                   failed_checks/canary_gate/rollback_gate/provenance/决定+理由
```

本阶段还把前几阶段"欠账"的三块拼图补齐了(它们都是 manifest 的原材料):`diagnose()` 补了 `change_contract`(期望修什么/可能改坏什么),`candidate_from_source` 补了 `patch_size` 和 `impact_prediction`/`generator_metadata`——生产者就位,消费者(manifest)同阶段点亮,数据流闭合。

## 3. 跟着数据走:两个候选,两个决定

**好候选**:`checks` 十格全 True,`candidate["changed"]=True` → `accepted=True` → decision=`release_to_canary`。manifest 里值得逐个看的字段:

- `stable_sha256` / `candidate_sha256` / `rollback_sha256`:三方指纹。回滚哈希 = 稳定版哈希——**回滚目标就是现在生产上跑的这个版本**,不是"某个老版本",没有歧义。
- `patch_size`:`{added: 8, deleted: 4, changed: 12}`——补丁尺寸进档案,"最小 diff"从口号变成可核查的数字。
- `canary_gate`:`scope: "shadow traffic only; stable remains unchanged"`,外加预声明的 `rollback_trigger`(任何一次不可重试重复,或临时恢复回归,立刻回滚)。**触发条件在发布前写死,不是出事后临场争论。**
- `provenance`:`{"generator": "deterministic", "model": null, "api_calls": 0}`——这份补丁谁生成的、调没调模型,留底待查(阶段 10 的 LLM 提案在这里会是另一副面孔)。

**捣乱候选**(偷运 `import os`):静态闸第二格就灭,后续全灭 → decision=`reject_candidate`,`rejection_reason="failed gates: security_scan, sandbox_execution, ..."`。注意理由是把**没过的灯全列出来**,而不是只报第一盏——审计者能看清它死得多彻底。这份拒绝也落盘成 `output/rejected_manifest.json`(**拒绝也要留档**:哪些提案被拒过、为什么,本身就是安全审计的一部分)。

**再一个边角规则**:如果一个候选"检查全绿"但 `changed=False`(根本没改任何东西),同样拒——理由是 "candidate did not change stable source"。自我修改连改都没改,不算完成修复。

## 4. 新技术点:无新 API,但有"决定公式"设计

本阶段零新 API。值得带走的是那个决定公式的两个细节:

```python
accepted = candidate.get("changed", False) and bool(checks) and all(checks.values())
```

1. **`bool(checks)`**:灯表为空也算不合格——"没跑检查"不等于"全过"。空列表 `all()` 返回 True 是 Python 经典坑,这里显式堵上。
2. **决定和理由一起产出**:`decision` 只有一个词,`rejection_reason` 却枚举所有失败项。机器读决定,人读理由——两种受众一次满足。

## 5. 关键顿悟

- **发布决定是一段确定性代码,不是一个角色**:全绿才放行,规则短到无法作弊。LLM(阶段 10)无论说得多么头头是道,决定都轮不到它做。
- **manifest 是"决定的证据链"**:哈希锚定产物、diff 锚定改动、checks 锚定验证、provenance 锚定出处、reason 锚定拒绝。审计的本质是"结论可以不信,证据必须齐全"。
- **放行 ≠ 上生产**:release_to_canary 的 scope 写死"影子流量,stable 不动",回滚触发条件预先声明。灰度是发布系统和生产系统之间的缓冲带,越过去要有新的证据。
- **拒绝也要落盘**:rejected_manifest.json 和 release_manifest.json 平级——安全系统里,"拦了什么"和"放了什么"同样值得审计。
