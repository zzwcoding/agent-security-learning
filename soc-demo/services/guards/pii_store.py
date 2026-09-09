"""PII mapstore（票 49·ADR 0004-3）：占位符→原文 映射的落盘真相。

FR-S4.2 原始口径是「映射仅服务端内存保留、run 结束即弃」；ADR 0004 裁决 3 改判：
做了映射就配一个受控反查口——映射落 guards 自持 sqlite（缺省
data/pii-mapstore.sqlite，仓库 .gitignore 的 data/ 已覆盖），重启不丢。
反查链路：web（duty_lead/admin）→ agent 过闸端点 → 本服务 /pii/reveal；
角色闸在 agent 侧（A.2 四族装不下「PII 反查」，端点级白名单，票面记票交 L0）。

敏感面口径（INV-4 金丝雀的类推）：本表内容（原文）只活在库里与「授权反查的
响应体」两处，绝不进日志/审计 details/错误消息——审计只记「谁查了占位符 X」，
不记查回了什么。

形态记票：wire 占位符保持 `<TYPE>` 不编号（FR-S4.1 契约与票 24 契约测试不动），
同一占位符的多个原文以列表全收——PRIMARY KEY (placeholder, original) 去重，
反查按首见序返回全部。
"""
import os
import sqlite3
import time

DDL = """
CREATE TABLE IF NOT EXISTS pii_map (
  placeholder TEXT NOT NULL,
  original TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  first_seen INTEGER NOT NULL,
  PRIMARY KEY (placeholder, original)
);
"""


def default_path() -> str:
    """库文件路径：env PII_MAPSTORE_PATH 覆盖（测试接缝）；缺省落在进程 CWD 的
    data/ 下（容器 WORKDIR=/app → compose 挂 ./data/guards:/app/data，同 agent
    库卷口径；本机开发跑在 services/guards/ 下，仓库 .gitignore 的 data/ 兜住）。"""
    return os.environ.get("PII_MAPSTORE_PATH", "data/pii-mapstore.sqlite")


class PiiMapStore:
    """sqlite 薄壳：record（脱敏时写）+ reveal（反查时读）。单连接复用——
    FastAPI 的 def 端点跑在线程池里，sqlite3 默认 check_same_thread=True 会炸，
    这里显式放行（写全是毫秒级小事务 + WAL，串行化由 sqlite 自己的锁兜底）。"""

    def __init__(self, path: str):
        if path != ":memory:":
            parent = os.path.dirname(path)
            if parent:
                os.makedirs(parent, exist_ok=True)
        self._conn = sqlite3.connect(path, check_same_thread=False)
        self._conn.execute("PRAGMA journal_mode = WAL")
        self._conn.executescript(DDL)
        self._conn.commit()

    def record(self, pairs: list[dict]) -> None:
        """写入 占位符→原文 对（重复对幂等）。pairs 元素：
        {placeholder: "<TYPE>", original: 原文切片, entity_type: TYPE}。"""
        now = int(time.time() * 1000)
        self._conn.executemany(
            "INSERT OR IGNORE INTO pii_map (placeholder, original, entity_type, first_seen)"
            " VALUES (?, ?, ?, ?)",
            [(p["placeholder"], p["original"], p["entity_type"], now) for p in pairs],
        )
        self._conn.commit()

    def reveal(self, placeholder: str) -> list[str]:
        """按占位符反查全部原文（首见序）。查无此人 = 空表，由调用方落 404。"""
        rows = self._conn.execute(
            "SELECT original FROM pii_map WHERE placeholder = ?"
            " ORDER BY first_seen, original",
            (placeholder,),
        ).fetchall()
        return [r[0] for r in rows]

    def close(self) -> None:
        self._conn.close()


_store_instance: PiiMapStore | None = None


def get_store() -> PiiMapStore:
    """进程级单例（pii.py _engines 同款缓存纪律）：库连接贵，全程复用。
    不用 lru_cache 是为了 reset 能诚实地先 close 旧连接再清指针。"""
    global _store_instance
    if _store_instance is None:
        _store_instance = PiiMapStore(default_path())
    return _store_instance


def reset_store() -> None:
    """测试接缝：关旧连清指针——env 换路后下一次 get_store() 重开新库。
    测试里它同时扮演「重启」：同一文件路径重开，映射还在 = 落盘生效。"""
    global _store_instance
    if _store_instance is not None:
        _store_instance.close()
        _store_instance = None
