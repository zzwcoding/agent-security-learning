"""混合管道(阶段 9):regex 先行,LLM 在脱敏后文本上补扫语义盲区。

分工的物质基础(阶段 3/7 的实测):规则微秒级、span 精确;LLM 秒级但能抓
正则写不出的类别。注意 LLM 是"总跑一遍"而不是"regex 零命中才跑"——
实测推翻过省成本版:住址(LLM 地盘)和手机号(regex 地盘)同一条日志时,
regex 命中了就不再叫 LLM,住址原样泄露。脱敏系统保完备优先于省钱。
"""
import time

from llm_engine import accept_and_redact, detect_pii
from regex_sanitizer import sanitize


def hybrid_sanitize(text: str) -> dict:
    """① regex 先行,先把格式型全脱掉;② LLM 在脱敏后文本上补扫语义盲区;
    ③ 过闸项顺序回填。返回脱敏文本与两段引擎的路径统计。"""
    started = time.perf_counter()
    redacted, findings = sanitize(text)
    regex_ms = (time.perf_counter() - started) * 1000

    llm_started = time.perf_counter()
    items, metrics = detect_pii(redacted)
    # 占位符污染防御:模型可能把刚生成的 [REDACTED_*] 当敏感值,还会摘内部词
    # (如从 [REDACTED_URL_CRED] 里抠出 REDACTED_URL_CRED 报"护照号")——
    # 只要 value 含 REDACTED 字样一律不收。
    items = [i for i in items if "redacted" not in (i.get("value") or "").lower()]
    redacted, accepted, rejected = accept_and_redact(redacted, items)

    return {"redacted": redacted, "regex_hits": len(findings), "regex_ms": regex_ms,
            "llm_ms": metrics["total_ms"], "llm_given": len(items),
            "llm_kept": len(accepted), "llm_rejected": len(rejected)}
