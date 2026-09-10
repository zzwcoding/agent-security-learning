"""store 模块公开接口：KB / 文档 / chunk 的 SQLite 持久化。

教学注释（阶段 1）：
- chunk 表是全系统的"唯一事实源"（INV-2）：之后向量、倒排、图谱、Wiki 四个维度
  全是从这张表投影出去的派生物，索引坏了随时能从 chunk 表重建。
- replace_chunks 用"先删后插"实现幂等：重新入库一份文档时先删光它的旧 chunk
  再写新的，数据库里永远不会新旧两份账并存（对位 WeKnora 入库前的幂等清理）。
"""

import sqlite3
from dataclasses import dataclass

_conn: sqlite3.Connection | None = None


@dataclass
class Document:
    id: int
    kb_id: int
    filename: str
    fmt: str
    status: str  # "done" / "failed"


@dataclass
class Chunk:
    id: int
    doc_id: int
    seq: int  # 在文档里排第几块，从 0 开始
    text: str


def init_db(path: str) -> None:
    """建库建表（幂等）。测试传 ":memory:" 起一座用完即焚的临时库。"""
    global _conn
    _conn = sqlite3.connect(path)
    _conn.row_factory = sqlite3.Row
    _conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS kb (id INTEGER PRIMARY KEY, name TEXT);
        CREATE TABLE IF NOT EXISTS document (
            id INTEGER PRIMARY KEY, kb_id INTEGER, filename TEXT, fmt TEXT, status TEXT
        );
        CREATE TABLE IF NOT EXISTS chunk (
            id INTEGER PRIMARY KEY, doc_id INTEGER, seq INTEGER, text TEXT
        );
        """
    )


def create_kb(name: str) -> int:
    cur = _conn.execute("INSERT INTO kb (name) VALUES (?)", (name,))
    _conn.commit()
    return cur.lastrowid


def create_document(kb_id: int, filename: str, fmt: str) -> int:
    cur = _conn.execute(
        "INSERT INTO document (kb_id, filename, fmt, status) VALUES (?, ?, ?, 'done')",
        (kb_id, filename, fmt),
    )
    _conn.commit()
    return cur.lastrowid


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
