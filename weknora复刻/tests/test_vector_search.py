"""阶段 3 · 向量检索 seam 测试。

绑定 spec rag-core.md 验收测试表第 9/10/12 行。
fake 向量手工构造：kitty 的向量直接造成和 cat 几乎同向——同义命中是"设计出来的近"，
真模型的语义魔法步 3.3 用真 GLM 验证。
"""

import numpy as np
import pytest

import llm_gateway
import retrieval
import store
from store import Chunk


def _cos(a, b):
    a, b = np.asarray(a, dtype=np.float64), np.asarray(b, dtype=np.float64)
    return float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b)))


def _seed_two_cats():
    store.init_db(":memory:")
    kb_id = store.create_kb("向量测试库")
    doc_id = store.create_document(kb_id, "animals.txt", "txt")
    store.replace_chunks(doc_id, [Chunk(0, doc_id, 0, "cat"), Chunk(0, doc_id, 1, "stock")])
    return kb_id


def test_cosine_direction_not_magnitude():
    """spec 第 9 行：余弦看方向不看长度（书 3.2 原文口径）——同方向、模长差 10 倍得分相等。"""
    llm_gateway.use_fake_backend()
    kb_id = _seed_two_cats()
    vecs = {"cat": [1.0, 1.0, 0.0], "stock": [0.0, 0.0, 1.0]}
    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(llm_gateway, "embed", lambda texts: [vecs[t] for t in texts])
        retrieval.index_chunks(kb_id)
        # 查询向量 = cat 方向 × 10 倍模长——得分应与 cat 方向 ×1 完全一致
        mp.setattr(llm_gateway, "embed", lambda texts: [[10.0, 10.0, 0.0] for _ in texts])
        hits = retrieval.vector_search(kb_id, "whatever")
    assert hits[0].chunk.text == "cat"
    assert hits[0].score == pytest.approx(1.0, rel=1e-6)  # 方向完全一致 → 余弦=1，与模长无关


def test_vector_search_synonym_hit():
    """spec 第 10 行：手工构造向量下 kitty→cat 命中（kitty 与 cat 同向、与 stock 正交）。"""
    llm_gateway.use_fake_backend()
    kb_id = _seed_two_cats()
    cat_dir = [1.0, 1.0, 0.0]
    vecs = {"cat": cat_dir, "stock": [0.0, 0.0, 1.0], "kitty": [0.99, 1.01, 0.0]}  # kitty ≈ cat 方向
    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(llm_gateway, "embed", lambda texts: [vecs[t] for t in texts])
        retrieval.index_chunks(kb_id)
        hits = retrieval.vector_search(kb_id, "kitty")
    assert hits[0].chunk.text == "cat"  # 没有共同词，BM25 绝不可能命中——向量靠"方向近"命中
    assert hits[0].score > 0.99
    assert hits[1].score < 0.01  # stock 与 kitty 方向正交


def test_index_chunks_roundtrip_and_count():
    """index_chunks 返回索引条数=子块数，embed 一次批量调用。"""
    llm_gateway.use_fake_backend()
    kb_id = _seed_two_cats()
    calls = []
    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(llm_gateway, "embed", lambda texts: calls.append(len(texts)) or [[1.0, 0.0] for _ in texts])
        n = retrieval.index_chunks(kb_id)
    assert n == 2 and calls == [2]  # 批量一趟，不是逐块调用
    assert len(store.load_embeddings(kb_id)) == 2


def test_vector_results_no_parent_chunks():
    """spec 第 12 行（INV-1 哨兵）：向量结果 ⊆ 可索引子块。票 0005 起真正受力。"""
    llm_gateway.use_fake_backend()
    kb_id = _seed_two_cats()
    retrieval.index_chunks(kb_id)
    child_ids = {c.id for c in store.list_child_chunks(kb_id)}
    for h in retrieval.vector_search(kb_id, "猫"):
        assert h.chunk.id in child_ids
