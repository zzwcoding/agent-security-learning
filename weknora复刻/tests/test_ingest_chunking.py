"""阶段 1 · ingest seam 测试。

绑定 spec rag-core.md 验收测试表第 1 行（固定 512 分块）、第 3 行（解析失败置失败态不阻塞）。
fixture：tests/fixtures/fixture_2000tokens.txt（恰好 2000 字符）、fixture_corrupted.bin（坏文件）。
"""

from pathlib import Path

import pytest

import ingest
import store
from ingest import ParseError

FIXTURES = "tests/fixtures"


def _fresh_kb() -> int:
    store.init_db(":memory:")
    return store.create_kb("测试库")


def test_chunk_fixed_size_512():
    """spec 验收第 1 行：2000 字符入库 → 4 块（⌈2000/512⌉），前 3 块满 512，末块 368。"""
    kb_id = _fresh_kb()
    doc_id = ingest.ingest_file(kb_id, f"{FIXTURES}/fixture_2000tokens.txt")
    chunks = store.list_chunks(doc_id)
    assert len(chunks) == 4
    assert [len(c.text) for c in chunks] == [512, 512, 512, 464]  # 2000 - 3×512 = 464
    expected = Path(f"{FIXTURES}/fixture_2000tokens.txt").read_text()
    assert "".join(c.text for c in chunks) == expected


def test_reingest_via_ingest_keeps_count():
    """管线级幂等：同一文档 reingest 后块数不变、内容不变。"""
    kb_id = _fresh_kb()
    doc_id = ingest.ingest_file(kb_id, f"{FIXTURES}/fixture_2000tokens.txt")
    before = [(c.seq, c.text) for c in store.list_chunks(doc_id)]
    ingest.reingest_document(doc_id)
    after = [(c.seq, c.text) for c in store.list_chunks(doc_id)]
    assert after == before


def test_parse_failure_marks_document_failed():
    """spec 验收第 3 行：坏文件置 failed 态且抛 ParseError；别的好文档照常入库。"""
    kb_id = _fresh_kb()
    with pytest.raises(ParseError):
        ingest.ingest_file(kb_id, f"{FIXTURES}/fixture_corrupted.bin")
    bad_doc_id = 1  # 本测试库里第一个登记的文档（ingest 先登记后解析，失败也留档）
    assert store.get_document(bad_doc_id).status == "failed"
    good_doc_id = ingest.ingest_file(kb_id, f"{FIXTURES}/fixture_2000tokens.txt")
    assert store.get_document(good_doc_id).status == "done"
    assert len(store.list_chunks(good_doc_id)) == 4
