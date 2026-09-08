"""PII 脱敏引擎（票 04）：Presidio 语义的确定性实现，接口契约照 PRD §6-M9-S4。

实体集 = Presidio zh/en 组合（memory_guard.py 路线 1 教训：内建识别器偏英文，中文
高频 PII 用正则识别器补；名单收窄防误报爆炸）。RFC1918 内网网段豁免 = 决策记录 #8
（内网 IP 是演示基建的一部分，不是出域隐私）。引擎留作 Presidio 真件的同契约替换位
（决策记录见票 04）。
"""
import re

# (实体类型, 编译正则)；顺序即优先级，重叠时保留更早/更长的命中
RECOGNIZERS = [
    ("EMAIL_ADDRESS", re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")),
    ("CN_ID", re.compile(r"(?<!\d)\d{17}[\dXx](?!\d)")),
    ("PHONE_NUMBER", re.compile(
        r"(?<!\d)(?:\+?\d{1,3}[- ])\d{3}[- ]\d{4}(?!\d)|(?<!\d)1[3-9]\d{9}(?!\d)")),
    ("CREDIT_CARD", re.compile(r"(?<!\d)(?:\d{4}[ -]?){3}\d{4}(?!\d)")),
    ("IP_ADDRESS", re.compile(r"(?<!\d)(?:\d{1,3}\.){3}\d{1,3}(?!\d)")),
]

# RFC1918：10.0.0.0/8、172.16.0.0/12、192.168.0.0/16（决策记录 #8 内网豁免）
RFC1918 = re.compile(
    r"^(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}"
    r"|192\.168\.\d{1,3}\.\d{1,3})$")


def _is_internal_ip(ip: str) -> bool:
    return bool(RFC1918.match(ip))


def anonymize(text: str, language: str = "zh") -> dict:
    """返回 {text: 占位符替换后的出域文本, entities: [{type,start,end}]}。

    start/end 指向原文（照 PRD S4 契约示例）；替换用类型占位符（FR-S4.1）。
    language 参数收下但引擎为双语模式（正则对 zh/en 同时生效）。
    """
    spans = []
    for entity_type, pattern in RECOGNIZERS:
        for m in pattern.finditer(text):
            value = m.group(0)
            if entity_type == "IP_ADDRESS" and _is_internal_ip(value):
                continue  # 内网豁免
            spans.append({"type": entity_type, "start": m.start(), "end": m.end()})
    spans = _drop_overlaps(spans)
    out = text
    for span in sorted(spans, key=lambda s: s["start"], reverse=True):
        out = out[:span["start"]] + f"<{span['type']}>" + out[span["end"]:]
    return {"text": out, "entities": sorted(spans, key=lambda s: s["start"])}


def _drop_overlaps(spans: list[dict]) -> list[dict]:
    """重叠时保留先声明的（更具体的实体在前）与更长的命中。"""
    kept: list[dict] = []
    for span in sorted(spans, key=lambda s: (s["start"], -(s["end"] - s["start"]))):
        if any(span["start"] < k["end"] and k["start"] < span["end"] for k in kept):
            continue
        kept.append(span)
    return kept
