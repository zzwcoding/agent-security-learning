"""retrieval 模块公开接口：手写稀疏+稠密检索（阶段 2：BM25 稀疏路）。

教学注释（阶段 2）：
- 倒排索引 = 书后的术语索引页：给定一个词，立刻找到含它的所有卡片，
  不用逐张翻（书 3.2 实验 3-5 原文比喻）。
- BM25 在 TF-IDF 上修两处：词频饱和（k1=1.2：出现 10 次不值 5 次的两倍）、
  长度归一化（b=0.75：长文档不能光凭字多拿高分）。公式照书 3.2 手写，不调库。
- IDF 按下限 0 截断（书 3.2：词出现在过半文档时取值为负，"实现中通常给它设一个下限"）。
"""

import math
import re
from dataclasses import dataclass

import store

K1 = 1.2  # 词频饱和速度
B = 0.75  # 长度归一化强度

_WORD = re.compile(r"[a-z0-9]+")
_CJK = re.compile(r"[一-鿿]")


@dataclass
class ScoredChunk:
    chunk: store.Chunk
    score: float
    source: str  # "bm25" / "vector" / "rrf" / "rerank"（RRF 与重排是阶段 4 的事）


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
        idf = max(0.0, math.log((n - len(inv[qt]) + 0.5) / (len(inv[qt]) + 0.5)))
        for i, tf in inv[qt]:
            dl = len(docs_tokens[i])
            scores[i] = scores.get(i, 0.0) + idf * tf * (K1 + 1) / (tf + K1 * (1 - B + B * dl / avgdl))

    hits = [ScoredChunk(chunks[i], s, "bm25") for i, s in scores.items() if s > 0]
    hits.sort(key=lambda h: -h.score)
    return hits[:top_k]
