"""阶段 2 · BM25 seam 测试（全部手算对照，公式照书 3.2 稀疏嵌入节）。

绑定 spec rag-core.md 验收测试表第 5–8 行。
固定布景（5 张卡片，分词按中文单字）：
  d1 "猫 猫 猫"(dl=3)  d2 "猫 狗"(dl=2)  d3 "狗 鱼"(dl=2)  d4 "鱼 鸟"(dl=2)  d5 "鸟 虫"(dl=2)
  N=5，avgdl=11/5=2.2；df: 猫=2 狗=2 鱼=2 鸟=2 虫=1
  IDF 用工程变体 ln(1+(N−df+0.5)/(df+0.5))（恒非负；书原公式在小语料退化，见 lessons/0002-1）：
  IDF(猫)=ln(1+3.5/2.5)=ln2.4≈0.8755；IDF(虫)=ln(1+4.5/1.5)=ln4≈1.3863
"""

import math

import store
from retrieval import bm25_search
from store import Chunk

K1, B = 1.2, 0.75  # 与 retrieval 实现共用同一对书外常数（Lucene 惯例 k1=1.2，书实验 3-5 用 1.5——公式结构才是重点）


def _seed5() -> int:
    store.init_db(":memory:")
    kb_id = store.create_kb("bm25测试库")
    doc_id = store.create_document(kb_id, "five.txt", "txt")
    texts = ["猫 猫 猫", "猫 狗", "狗 鱼", "鱼 鸟", "鸟 虫"]
    store.replace_chunks(doc_id, [Chunk(0, doc_id, i, t) for i, t in enumerate(texts)])
    return kb_id


def test_bm25_idf_formula():
    """spec 第 5 行：稀有词 IDF 手算对照——查"虫"(df=1)，只命中 d5，分值=IDF(ln3)×TF 部件。"""
    kb_id = _seed5()
    hits = bm25_search(kb_id, "虫")
    assert len(hits) == 1 and hits[0].chunk.text == "鸟 虫"
    idf = math.log(1 + (5 - 1 + 0.5) / (1 + 0.5))  # ln4（工程变体）
    tf_part = 1 * (K1 + 1) / (1 + K1 * (1 - B + B * 2 / 2.2))
    assert hits[0].score == pytest_approx(idf * tf_part)


def test_bm25_tf_saturation_k1():
    """spec 第 6 行：词频饱和——"猫"在 d1 出现 3 次、d2 出现 1 次，得分比 ≠ 3，且与手算一致。"""
    kb_id = _seed5()
    hits = bm25_search(kb_id, "猫")
    assert [h.chunk.text for h in hits] == ["猫 猫 猫", "猫 狗"]  # d1 在前
    s1, s2 = hits[0].score, hits[1].score
    part_d1 = 3 * (K1 + 1) / (3 + K1 * (1 - B + B * 3 / 2.2))
    part_d2 = 1 * (K1 + 1) / (1 + K1 * (1 - B + B * 2 / 2.2))
    assert s1 / s2 == pytest_approx(part_d1 / part_d2)  # IDF 相约，纯比 TF 部件
    assert s1 / s2 < 3  # 词频饱和：3 倍词频换不来 3 倍分（k1 的边际递减）


def test_bm25_length_norm_b():
    """spec 第 7 行：长度归一化——同词频，8 字长卡片得分 < 2 字短卡片，数值手算一致。"""
    store.init_db(":memory:")
    kb_id = store.create_kb("长度测试库")
    doc_id = store.create_document(kb_id, "len.txt", "txt")
    # 虎 df=1；两张含虎卡片同词频、长度 4 倍差；avgdl=(2+8+2+2+2)/5=3.2
    texts = ["虎 山", "虎 山 林 森 木 石 水 火", "春 花", "秋 月", "夏 风"]
    store.replace_chunks(doc_id, [Chunk(0, doc_id, i, t) for i, t in enumerate(texts)])
    hits = bm25_search(kb_id, "虎")
    assert [h.chunk.text for h in hits] == ["虎 山", "虎 山 林 森 木 石 水 火"]
    # 虎在 5 张卡里出现 2 次（短卡+长卡各一次），df=2：IDF=ln(1+3.5/2.5)=ln2.4
    idf = math.log(1 + (5 - 2 + 0.5) / (2 + 0.5))
    avgdl = 3.2
    short_part = 1 * (K1 + 1) / (1 + K1 * (1 - B + B * 2 / avgdl))
    long_part = 1 * (K1 + 1) / (1 + K1 * (1 - B + B * 8 / avgdl))
    assert hits[0].score == pytest_approx(idf * short_part)
    assert hits[1].score == pytest_approx(idf * long_part)


def test_bm25_results_no_parent_chunks():
    """spec 第 8 行（INV-1 哨兵）：BM25 结果集合 ⊆ 可索引子块。票 0005 引入父子块后真正受力。"""
    kb_id = _seed5()
    child_ids = {c.id for c in store.list_child_chunks(kb_id)}
    for h in bm25_search(kb_id, "猫"):
        assert h.chunk.id in child_ids


def test_bm25_tiny_corpus_still_hits():
    """回归（2026-09-10 实踩）：库里只有 1 张卡片时查询也要能命中——
    书原 IDF 公式此时取负值（词出现在过半文档），工程变体恒非负。"""
    store.init_db(":memory:")
    kb_id = store.create_kb("小语料库")
    doc_id = store.create_document(kb_id, "one.txt", "txt")
    store.replace_chunks(doc_id, [Chunk(0, doc_id, 0, "cat")])
    hits = bm25_search(kb_id, "cat")
    assert len(hits) == 1 and hits[0].score > 0


def pytest_approx(x):
    import pytest

    return pytest.approx(x, rel=1e-9)
