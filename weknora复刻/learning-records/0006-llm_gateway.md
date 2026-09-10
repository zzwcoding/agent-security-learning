# 0006 · 阶段 3 步 3.1：llm_gateway 唯一出网口

- 日期：2026-09-10
- 学了什么：唯一出网口三理由（CI 不花钱不抖/换商改配置/椒图接入面）；fake stub 词级哈希叠加伪造语义；monkeypatch 间谍注入测真实路的 URL；httpx 单点 `_post`。
- 卡在哪：无（httpx 按模块卡点名引入，依赖新增已进 requirements.txt）。
- 结论：gateway 四函数就位（chat/embed/backend_name/use_fake_backend），配置面全环境变量、调用时读取；4 测试绿（含 spec 第 11/26 行），总 15 绿、四道门绿。`scripts/run-with-keychain.sh` 就位（agent-key glm 注入启动）。
- 下一步：步 3.2 store 向量 blob + numpy 手写余弦 + vector_search + index_chunks（fake 下闭环）。
