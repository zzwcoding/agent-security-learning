"""阶段 4 · RRF 融合 seam 测试（手算对照）。

绑定 spec rag-core.md 验收测试表第 13 行（RRF k=60 手算）、第 14 行前半（SearchTrace 中间态）。
布景：BM25 路 [A, B]，向量路 [B, C, A]（名次纯人工指定）：
  A: 1/61 + 1/63 ≈ 0.032266   B: 1/62 + 1/61 ≈ 0.032522   C: 1/62 ≈ 0.016129
  融合名次：B > A > C（B 两路都在前二，赢得综合第一——RRF 奖励"两边都认"的选手）
"""

import pytest

import retrieval
import store
from retrieval import ScoredChunk
from store import Chunk


def _seed3():
    store.init_db(":memory:")
    kb_id = store.create_kb("rrf测试库")
    doc_id = store.create_document(kb_id, "abc.txt", "txt")
    store.replace_chunks(
        doc_id, [Chunk(0, doc_id, 0, "A"), Chunk(0, doc_id, 1, "B"), Chunk(0, doc_id, 2, "C")]
    )
    return kb_id, store.list_chunks(doc_id)


def _canned(monkeypatch, chunks):
    a, b, c = chunks
    monkeypatch.setattr(retrieval, "bm25_search", lambda *a_, **k_: [ScoredChunk(a, 9.0, "bm25"), ScoredChunk(b, 8.0, "bm25")])
    monkeypatch.setattr(
        retrieval,
        "vector_search",
        lambda *a_, **k_: [ScoredChunk(b, 0.9, "vector"), ScoredChunk(c, 0.8, "vector"), ScoredChunk(a, 0.7, "vector")],
    )


def test_rrf_fusion_rank_handcalc(monkeypatch):
    """spec 第 13 行：给定两路名次，fused 的融合分与名次与手算 Σ1/(60+rank) 完全一致。"""
    kb_id, chunks = _seed3()
    _canned(monkeypatch, chunks)
    trace = retrieval.hybrid_search(kb_id, "任意查询")
    assert [h.chunk.text for h in trace.fused] == ["B", "A", "C"]
    assert trace.fused[0].score == pytest.approx(1 / 62 + 1 / 61)  # B：bm25 第2 + vector 第1
    assert trace.fused[1].score == pytest.approx(1 / 61 + 1 / 63)  # A：bm25 第1 + vector 第3
    assert trace.fused[2].score == pytest.approx(1 / 62)  # C：只在 vector 第2


def test_rrf_fuses_lane_exclusive_chunk(monkeypatch):
    """只在一路出现的卡片也进融合池（C 只被向量召回，BM25 没见过它——BM25 零命中不拖累它）。"""
    kb_id, chunks = _seed3()
    _canned(monkeypatch, chunks)
    trace = retrieval.hybrid_search(kb_id, "任意查询")
    assert "C" in [h.chunk.text for h in trace.fused]


def test_search_trace_intermediate_states(monkeypatch):
    """spec 第 14 行（本步覆盖三份）：bm25_hits / vector_hits / fused 齐全且 fused=两路名次的 RRF。"""
    kb_id, chunks = _seed3()
    _canned(monkeypatch, chunks)
    trace = retrieval.hybrid_search(kb_id, "任意查询")
    assert [h.chunk.text for h in trace.bm25_hits] == ["A", "B"]
    assert [h.chunk.text for h in trace.vector_hits] == ["B", "C", "A"]
    assert len(trace.fused) == 3
    assert all(h.source == "rrf" for h in trace.fused)
