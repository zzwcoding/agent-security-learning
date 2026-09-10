"""阶段 1 · store seam 测试。

绑定 spec rag-core.md 验收测试表第 2 行（重入库幂等，INV-2）。
seam 口径：只测公开接口（init_db/create_kb/create_document/replace_chunks/list_chunks），
不碰内部 SQL；每个测试用 ":memory:" 起独立库，互不串味。
"""

import store
from store import Chunk


def _fresh_doc() -> int:
    store.init_db(":memory:")
    kb_id = store.create_kb("测试库")
    return store.create_document(kb_id, "a.txt", "txt")


def test_chunk_roundtrip():
    """写进去的 chunk 原样读回：序位、正文一个字符不差。"""
    doc_id = _fresh_doc()
    store.replace_chunks(doc_id, [Chunk(0, doc_id, 0, "第一块"), Chunk(0, doc_id, 1, "第二块")])
    got = store.list_chunks(doc_id)
    assert [(c.seq, c.text) for c in got] == [(0, "第一块"), (1, "第二块")]


def test_reingest_idempotent_chunks():
    """spec 验收第 2 行：重入库两次，chunk 与末次一致、无重复、无旧账残留（INV-2）。"""
    doc_id = _fresh_doc()
    store.replace_chunks(doc_id, [Chunk(0, doc_id, 0, "旧版本"), Chunk(0, doc_id, 1, "旧版本二")])
    store.replace_chunks(doc_id, [Chunk(0, doc_id, 0, "新版本")])
    got = store.list_chunks(doc_id)
    assert [(c.seq, c.text) for c in got] == [(0, "新版本")]
