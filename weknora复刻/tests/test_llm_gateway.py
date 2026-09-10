"""阶段 3 · llm_gateway seam 测试。

绑定 spec rag-core.md 验收测试表第 11 行（embed 批量形状）、第 26 行（gateway 配置面）。
全程不碰网络：fake stub 确定性 + 真实后端的 HTTP 出口 `_post` 被替换捕获。
"""

import llm_gateway


def test_fake_backend_deterministic():
    """fake stub：同输入同输出，不要网不花钱（CI 的定海神针）。"""
    llm_gateway.use_fake_backend()
    v1 = llm_gateway.embed(["猫吃鱼"])[0]
    v2 = llm_gateway.embed(["猫吃鱼"])[0]
    assert v1 == v2
    assert llm_gateway.chat([{"role": "user", "content": "你好"}]) == llm_gateway.chat(
        [{"role": "user", "content": "你好"}]
    )


def test_embed_batch_shape():
    """spec 第 11 行：fake 后端返回向量数=输入文本数、维度=配置维度。"""
    llm_gateway.use_fake_backend()
    vecs = llm_gateway.embed(["a", "b", "c"])
    assert len(vecs) == 3
    assert all(len(v) == 2048 for v in vecs)


def test_fake_embed_token_overlap_semantics():
    """fake 向量的伪造语义：共享词越多越近——"cat feline" 比 "stock" 更接近 "cat"。"""
    import numpy as np

    llm_gateway.use_fake_backend()
    q, near, far = llm_gateway.embed(["cat", "cat feline", "stock"])
    cos = lambda a, b: float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b)))
    assert cos(q, near) > cos(q, far)


def test_gateway_base_url_configurable(monkeypatch):
    """spec 第 26 行：base_url 走环境变量（ADR 0002 椒图预留）；默认=智谱端点。"""
    captured = {}

    def spy_post(url, api_key, payload):
        captured["url"] = url
        return {"choices": [{"message": {"content": "ok"}}]}

    monkeypatch.setattr(llm_gateway, "_post", spy_post)
    monkeypatch.setattr(llm_gateway, "_backend", "glm")

    monkeypatch.delenv("WEKNORA_LLM_BASE_URL", raising=False)
    llm_gateway.chat([{"role": "user", "content": "hi"}])
    assert captured["url"].startswith("https://open.bigmodel.cn/api/paas/v4")

    monkeypatch.setenv("WEKNORA_LLM_BASE_URL", "http://localhost:9000")  # 改指椒图=只改这里
    llm_gateway.chat([{"role": "user", "content": "hi"}])
    assert captured["url"] == "http://localhost:9000/chat/completions"
