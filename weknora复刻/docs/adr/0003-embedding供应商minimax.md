# ADR 0003 · embedding 供应商：智谱 embedding-3 → MiniMax embo-01

- 日期：2026-09-10
- 触发：阶段 3.3 真 GLM 首跑，chat（glm-4-flash 免费档）通，embedding-3 被智谱返回 429"余额不足或无可用资源包"（错误码 1113）。
- 决策：**chat 继续走智谱 GLM（免费），embedding 改走 MiniMax embo-01**（用户 Keychain 已有 key）。gateway 的 embed 路独立配置（`WEKNORA_EMBED_BASE_URL/API_KEY/MODEL`），响应形状按内容自适应（MiniMax `vectors` 键 / OpenAI 兼容 `data` 键）。
- 实测证据（2026-09-10，真实 API）：embo-01 输出 1536 维；cos(kitty,cat)=0.7448 vs cos(kitty,stock)=0.2472——语义检索魔法成立。
- 影响：PRD §8.1-5 供应商口径更新（1536 维，§5 向量内存估算 25MB→18MB）；payload 同带 `texts`/`input` 两键兼容两家；MiniMax 的 type=db/query 非对称嵌入统一用 db（有意简化，对账报告交代）。
- 教学价值（意外收获）：换供应商只动了 gateway 一个模块 + 环境变量——"唯一出网口"的第一次实战分红。
- 拒绝的替代方案：a. 充值智谱（能用但没必要花钱）；b. Ollama bge-m3 本地（多一个服务要起，留作未来番外）。
