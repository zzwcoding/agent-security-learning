"""ingest 模块公开接口：解析 + 分块 + 入库管线。

教学注释（阶段 1）：
- 分块是"把书剪成知识卡片"的工序。本阶段用固定大小硬切（最简单的那类策略），
  重叠和父子分块到阶段 5 才升级——先跑通，再切得好。
- 解析失败不是事故是常态：坏文件置 failed 态、其他文档照常入库，
  一条坏鱼不许搅一锅汤（PRD §7-⑨）。
"""

from pathlib import Path

import store
from store import Chunk


class ParseError(Exception):
    """文件解析失败（格式不支持 / 文件损坏）。"""


def parse_file(path: str) -> str:
    """读 txt 为文本；非 txt 或读不出来抛 ParseError（PDF 是票 0007 的事）。"""
    p = Path(path)
    if p.suffix != ".txt":
        raise ParseError(f"暂不支持的格式: {p.suffix or '(无扩展名)'}")
    try:
        return p.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as e:
        raise ParseError(str(e)) from e


def chunk_text(text: str, size: int = 512) -> list[str]:
    """固定大小分块：每块 size 个单位，到点硬切。

    教学口径：用字符数近似 token 数（有意简化——真 WeKnora 用分词器算 token，
    差距进收官对账报告）。书 3.2 建议起点：每块 256–1024 token、重叠 10–20%。
    """
    return [text[i : i + size] for i in range(0, len(text), size)]


def ingest_file(kb_id: int, path: str) -> int:
    """全管线入口：登记文档 → 解析 → 分块 → 入库；解析失败置 failed 态再抛出。"""
    p = Path(path)
    doc_id = store.create_document(kb_id, p.name, p.suffix.lstrip("."), str(p))
    try:
        text = parse_file(path)
    except ParseError:
        store.set_document_status(doc_id, "failed")
        raise
    chunks = [Chunk(0, doc_id, i, t) for i, t in enumerate(chunk_text(text))]
    store.replace_chunks(doc_id, chunks)
    return doc_id


def reingest_document(doc_id: int) -> None:
    """幂等重建：按登记的路径重读原文、重切、整批换新（先删后插，INV-2）。"""
    doc = store.get_document(doc_id)
    text = parse_file(doc.path)
    chunks = [Chunk(0, doc_id, i, t) for i, t in enumerate(chunk_text(text))]
    store.replace_chunks(doc_id, chunks)
    store.set_document_status(doc_id, "done")
