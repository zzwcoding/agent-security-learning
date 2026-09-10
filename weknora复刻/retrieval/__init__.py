"""retrieval 模块公开接口：手写稀疏+稠密检索（阶段 2：BM25 稀疏路）。

教学注释（阶段 2）：
- 倒排索引 = 书后的术语索引页：给定一个词，立刻找到含它的所有卡片，
  不用逐张翻（书 3.2 实验 3-5 原文比喻）。
- BM25 在 TF-IDF 上修两处：词频饱和（k1=1.2：出现 10 次不值 5 次的两倍）、
  长度归一化（b=0.75：长文档不能光凭字多拿高分）。公式照书 3.2 手写，不调库。
- IDF 用工程变体 ln(1+(N−df+0.5)/(df+0.5))：恒非负。书上原公式 ln((N−df+0.5)/(df+0.5))
  在小语料（词出现在过半卡片）时取负值——2026-09-10 实踩：库里只有 1 张卡片时
  任何词 IDF 都是负的、截断后零命中。Lucene/Elasticsearch 同款变体，排序性质不变。
"""

import math
import re
from dataclasses import dataclass

import numpy as np

import llm_gateway
import store

K1 = 1.2  # 词频饱和速度
B = 0.75  # 长度归一化强度

_WORD = re.compile(r"[a-z0-9]+")
_CJK = re.compile(r"[一-鿿]")


@dataclass
class ScoredChunk:
    chunk: store.Chunk
    score: float
    source: str  # "bm25" / "vector" / "rrf" / "rerank"（重排是步 4.2 的事）


@dataclass
class SearchTrace:
    """一次混合检索的中间态全记录——页面对照视图的数据面（不另开查询面）。

    reranked 字段步 4.2 才长出来（LLM 教学版重排）。
    """

    bm25_hits: list[ScoredChunk]
    vector_hits: list[ScoredChunk]
    fused: list[ScoredChunk]


RRF_K = 60  # 平滑常数（书 3.2 常取值）：压低前几名之间的分差


def tokenize(text: str) -> list[str]:
    """分词：英文数字按词、中文按单字（教学简化；不去停用词——IDF 自会收拾"的"）。"""
    return _WORD.findall(text.lower()) + _CJK.findall(text)


def _build_inverted_index(docs_tokens: list[list[str]]) -> dict[str, list[tuple[int, int]]]:
    """倒排索引：词 → [(卡片序号, 词频)]。普通索引答"这张卡片含哪些词"，倒排反过来答"这个词在哪些卡片里"。"""
    inv: dict[str, list[tuple[int, int]]] = {}
    for i, tokens in enumerate(docs_tokens):
        for t in set(tokens):
            inv.setdefault(t, []).append((i, tokens.count(t)))
    return inv


def bm25_search(kb_id: int, query: str, top_k: int = 10) -> list[ScoredChunk]:
    """BM25 稀疏检索。量级小（PRD §5 千级卡片），每次查询现建倒排索引——诚实且无缓存失效坑。"""
    chunks = store.list_child_chunks(kb_id)
    if not chunks:
        return []
    docs_tokens = [tokenize(c.text) for c in chunks]
    avgdl = sum(len(t) for t in docs_tokens) / len(docs_tokens)
    n = len(docs_tokens)
    inv = _build_inverted_index(docs_tokens)

    scores: dict[int, float] = {}
    for qt in set(tokenize(query)):
        if qt not in inv:
            continue  # 词不在库里，倒排直接告诉我们：零命中
        idf = math.log(1 + (n - len(inv[qt]) + 0.5) / (len(inv[qt]) + 0.5))  # 恒非负变体（见模块注释）
        for i, tf in inv[qt]:
            dl = len(docs_tokens[i])
            scores[i] = scores.get(i, 0.0) + idf * tf * (K1 + 1) / (tf + K1 * (1 - B + B * dl / avgdl))

    hits = [ScoredChunk(chunks[i], s, "bm25") for i, s in scores.items() if s > 0]
    hits.sort(key=lambda h: -h.score)
    return hits[:top_k]


def index_chunks(kb_id: int) -> int:
    """建/重建向量投影：子块（INV-1）→ llm_gateway.embed 批量嵌入 → 存 blob。返回索引条数。"""
    chunks = store.list_child_chunks(kb_id)
    if not chunks:
        return 0
    vecs = llm_gateway.embed([c.text for c in chunks])
    store.save_embeddings(kb_id, [(c.id, v) for c, v in zip(chunks, vecs, strict=True)])
    return len(chunks)


def vector_search(kb_id: int, query: str, top_k: int = 10) -> list[ScoredChunk]:
    """稠密向量检索：查询词也 embed 成向量，numpy 手写余弦，暴力全扫（PRD §5：<100ms）。"""
    chunks_by_id = {c.id: c for c in store.list_child_chunks(kb_id)}
    qv = np.asarray(llm_gateway.embed([query])[0], dtype=np.float32)
    hits = []
    for chunk_id, vec in store.load_embeddings(kb_id):
        if chunk_id not in chunks_by_id:
            continue  # 孤儿投影（chunk 已删）不碰——INV-2 的防守
        cos = float(np.dot(qv, vec) / (np.linalg.norm(qv) * np.linalg.norm(vec) + 1e-9))
        hits.append(ScoredChunk(chunks_by_id[chunk_id], cos, "vector"))
    hits.sort(key=lambda h: -h.score)
    return hits[:top_k]


def _rrf_fuse(lanes: list[list[ScoredChunk]], top_k: int) -> list[ScoredChunk]:
    """倒数排名融合：抛开原始分数只看名次，得分 = Σ 1/(60+rank)（书 3.2 混合检索节）。

    为什么不能用原始分数直接加：余弦在 0~1，BM25 是 0~几十，尺度完全不同——
    两个评委一个打百分制一个打十分制，直接加总等于让百分制评委独裁。
    RRF 的办法：都只许报名次，名次换成倒数分再相加。
    """
    scores: dict[int, float] = {}
    by_id: dict[int, store.Chunk] = {}
    for hits in lanes:
        for rank, h in enumerate(hits, 1):
            scores[h.chunk.id] = scores.get(h.chunk.id, 0.0) + 1.0 / (RRF_K + rank)
            by_id[h.chunk.id] = h.chunk
    ranked = sorted(scores.items(), key=lambda kv: -kv[1])[:top_k]
    return [ScoredChunk(by_id[cid], s, "rrf") for cid, s in ranked]


def hybrid_search(kb_id: int, query: str, top_k: int = 10) -> SearchTrace:
    """混合检索：两路并行召回 → RRF 融合（重排步 4.2 接在 fused 之后）。"""
    b = bm25_search(kb_id, query, top_k)
    v = vector_search(kb_id, query, top_k)
    return SearchTrace(bm25_hits=b, vector_hits=v, fused=_rrf_fuse([b, v], top_k))
