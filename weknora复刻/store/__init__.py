"""store 模块公开接口：KB / 文档 / chunk 的 SQLite 持久化。

教学注释（阶段 1）：
- chunk 表是全系统的"唯一事实源"（INV-2）：之后向量、倒排、图谱、Wiki 四个维度
  全是从这张表投影出去的派生物，索引坏了随时能从 chunk 表重建。
- replace_chunks 用"先删后插"实现幂等：重新入库一份文档时先删光它的旧 chunk
  再写新的，数据库里永远不会新旧两份账并存（对位 WeKnora 入库前的幂等清理）。
"""

import sqlite3
from dataclasses import dataclass
from pathlib import Path

import numpy as np

_conn: sqlite3.Connection | None = None


@dataclass
class Document:
    id: int
    kb_id: int
    filename: str
    fmt: str
    status: str  # "done" / "failed"
    path: str  # 原文件路径——reingest 重建时要按它重读原文


@dataclass
class Chunk:
    id: int
    doc_id: int
    seq: int  # 在文档里排第几块，从 0 开始
    text: str


def init_db(path: str) -> None:
    """建库建表（幂等）。测试传 ":memory:" 起一座用完即焚的临时库。"""
    global _conn
    if path != ":memory:":
        Path(path).parent.mkdir(parents=True, exist_ok=True)
    _conn = sqlite3.connect(path)
    _conn.row_factory = sqlite3.Row
    _conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS kb (id INTEGER PRIMARY KEY, name TEXT);
        CREATE TABLE IF NOT EXISTS document (
            id INTEGER PRIMARY KEY, kb_id INTEGER, filename TEXT, fmt TEXT, status TEXT, path TEXT
        );
        CREATE TABLE IF NOT EXISTS chunk (
            id INTEGER PRIMARY KEY, doc_id INTEGER, seq INTEGER, text TEXT
        );
        CREATE TABLE IF NOT EXISTS embedding (
            kb_id INTEGER, chunk_id INTEGER PRIMARY KEY, vector BLOB
        );
        """
    )


def create_kb(name: str) -> int:
    cur = _conn.execute("INSERT INTO kb (name) VALUES (?)", (name,))
    _conn.commit()
    return cur.lastrowid


def create_document(kb_id: int, filename: str, fmt: str, path: str = "") -> int:
    cur = _conn.execute(
        "INSERT INTO document (kb_id, filename, fmt, status, path) VALUES (?, ?, ?, 'done', ?)",
        (kb_id, filename, fmt, path),
    )
    _conn.commit()
    return cur.lastrowid


def get_document(doc_id: int) -> Document:
    r = _conn.execute(
        "SELECT id, kb_id, filename, fmt, status, path FROM document WHERE id = ?", (doc_id,)
    ).fetchone()
    return Document(id=r["id"], kb_id=r["kb_id"], filename=r["filename"], fmt=r["fmt"], status=r["status"], path=r["path"])


def replace_chunks(doc_id: int, chunks: list[Chunk]) -> None:
    """先删后插：同一份文档重新入库时，旧 chunk 一块不留（INV-2 幂等重建的前提）。"""
    _conn.execute("DELETE FROM chunk WHERE doc_id = ?", (doc_id,))
    _conn.executemany(
        "INSERT INTO chunk (doc_id, seq, text) VALUES (?, ?, ?)",
        [(doc_id, c.seq, c.text) for c in chunks],
    )
    _conn.commit()


def list_chunks(doc_id: int) -> list[Chunk]:
    rows = _conn.execute(
        "SELECT id, doc_id, seq, text FROM chunk WHERE doc_id = ? ORDER BY seq", (doc_id,)
    ).fetchall()
    return [Chunk(id=r["id"], doc_id=r["doc_id"], seq=r["seq"], text=r["text"]) for r in rows]


def set_document_status(doc_id: int, status: str) -> None:
    _conn.execute("UPDATE document SET status = ? WHERE id = ?", (status, doc_id))
    _conn.commit()


def list_kbs() -> list[dict]:
    rows = _conn.execute("SELECT id, name FROM kb ORDER BY id").fetchall()
    return [{"id": r["id"], "name": r["name"]} for r in rows]


def list_documents(kb_id: int) -> list[Document]:
    rows = _conn.execute(
        "SELECT id, kb_id, filename, fmt, status, path FROM document WHERE kb_id = ? ORDER BY id",
        (kb_id,),
    ).fetchall()
    return [
        Document(id=r["id"], kb_id=r["kb_id"], filename=r["filename"], fmt=r["fmt"], status=r["status"], path=r["path"])
        for r in rows
    ]


def list_child_chunks(kb_id: int) -> list[Chunk]:
    """KB 下全部可索引卡片（阶段 5 引入父子块后只含子块；现在所有卡片都是子块）。"""
    rows = _conn.execute(
        "SELECT c.id, c.doc_id, c.seq, c.text FROM chunk c"
        " JOIN document d ON c.doc_id = d.id WHERE d.kb_id = ? ORDER BY c.id",
        (kb_id,),
    ).fetchall()
    return [Chunk(id=r["id"], doc_id=r["doc_id"], seq=r["seq"], text=r["text"]) for r in rows]


def save_embeddings(kb_id: int, items: list[tuple[int, list[float]]]) -> None:
    """存向量投影（chunk 的派生物，INV-2）。按 KB 先清后写——投影随 chunk 整批重建。"""
    _conn.execute("DELETE FROM embedding WHERE kb_id = ?", (kb_id,))
    _conn.executemany(
        "INSERT INTO embedding (kb_id, chunk_id, vector) VALUES (?, ?, ?)",
        [(kb_id, cid, np.asarray(v, dtype=np.float32).tobytes()) for cid, v in items],
    )
    _conn.commit()


def load_embeddings(kb_id: int) -> list[tuple[int, "np.ndarray"]]:
    """读向量投影：返回 [(chunk_id, numpy 向量)]。数学运算不归本模块（归 retrieval）。"""
    rows = _conn.execute("SELECT chunk_id, vector FROM embedding WHERE kb_id = ?", (kb_id,)).fetchall()
    return [(r["chunk_id"], np.frombuffer(r["vector"], dtype=np.float32)) for r in rows]
