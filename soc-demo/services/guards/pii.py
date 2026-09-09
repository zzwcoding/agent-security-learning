"""PII 脱敏（票 24）：Microsoft Presidio 真引擎，接口契约照 PRD §6-M9-S4 不变。

票 04 的手写 5 识别器换成了 Presidio 的识别器注册表（ADR 0002 框架红线：点名框架
必须真上）——找实体的是 AnalyzerEngine，替换占位符的是 AnonymizerEngine，本模块只剩
三样「配置」：自定义识别器（CN 手机号/CN 身份证）、RFC1918 豁免识别器（决策 #8，
override 内建 IpRecognizer）、实体清单与重叠优先级。

language 参数收下但走双语模式：识别器统一注册在 lang_code "en" 名下（语言码只是
Presidio 的路由键），正则/内建识别器对 zh/en 文本同时生效——与参考工程
memory_guard.py 同款做法。
"""
import re
from functools import lru_cache

from presidio_analyzer import (
    AnalyzerEngine,
    Pattern,
    PatternRecognizer,
    RecognizerResult,
)
from presidio_analyzer.nlp_engine import NlpEngineProvider
from presidio_analyzer.predefined_recognizers import IpRecognizer
from presidio_anonymizer import AnonymizerEngine
from presidio_anonymizer.entities import OperatorConfig

from pii_store import get_store

# 五识别器契约实体（票 04 契约）：列表顺序即重叠优先级，靠前/更长者优先保留
ENTITY_TYPES = ["EMAIL_ADDRESS", "CN_ID", "PHONE_NUMBER", "CREDIT_CARD", "IP_ADDRESS"]

# RFC1918：10.0.0.0/8、172.16.0.0/12、192.168.0.0/16（决策记录 #8 内网豁免）
RFC1918 = re.compile(
    r"^(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}"
    r"|192\.168\.\d{1,3}\.\d{1,3})$")


class Rfc1918ExemptIpRecognizer(IpRecognizer):
    """内网 IP 豁免识别器：替换注册表里的内建 IpRecognizer。

    安全工具的世界里内网 IP 是同主机归并/资产核对的关键证据，不是出域隐私
    （决策 #8）；公网 IP 照脱——外联 C2 检测要的正是外网地址本身。
    """

    def analyze(self, text, entities, nlp_artifacts=None, regex_flags=None):
        results = super().analyze(text, entities, nlp_artifacts, regex_flags)
        return [r for r in results if not RFC1918.match(text[r.start:r.end])]


def _zh_recognizers() -> list[PatternRecognizer]:
    """内建识别器覆盖不到的中国大陆高频 PII，用自定义 PatternRecognizer 补

    （票 24 验收 3：中文识别器用自定义 PatternRecognizer）。"""
    return [
        PatternRecognizer(
            supported_entity="PHONE_NUMBER",
            patterns=[Pattern(name="cn_mobile", regex=r"(?<!\d)1[3-9]\d{9}(?!\d)", score=0.6)],
            supported_language="en"),
        PatternRecognizer(
            supported_entity="CN_ID",
            patterns=[Pattern(name="cn_id", regex=r"(?<!\d)\d{17}[\dXx](?!\d)", score=0.6)],
            supported_language="en"),
    ]


@lru_cache(maxsize=1)
def _engines() -> tuple[AnalyzerEngine, AnonymizerEngine]:
    """模型加载慢且全程复用：单例缓存，首次调用才初始化。

    NLP 引擎钉 en_core_web_sm（~12MB，ADR 0002 允许 CI 安装）；不传配置的话
    Presidio 默认会去拉 en_core_web_lg（390MB+），CI 直接装不下。
    """
    nlp = NlpEngineProvider(nlp_configuration={
        "nlp_engine_name": "spacy",
        "models": [{"lang_code": "en", "model_name": "en_core_web_sm"}],
    }).create_engine()
    analyzer = AnalyzerEngine(nlp_engine=nlp, supported_languages=["en"])
    analyzer.registry.remove_recognizer("IpRecognizer")  # 换成 RFC1918 豁免版
    analyzer.registry.add_recognizer(Rfc1918ExemptIpRecognizer(supported_language="en"))
    for recognizer in _zh_recognizers():
        analyzer.registry.add_recognizer(recognizer)
    return analyzer, AnonymizerEngine()


def _drop_overlaps(spans: list[RecognizerResult]) -> list[RecognizerResult]:
    """重叠时保留更早/更长的命中（票 04 语义原样，搬运到 Presidio 结果对象上）。"""
    kept: list[RecognizerResult] = []
    for span in sorted(spans, key=lambda s: (s.start, -(s.end - s.start))):
        if any(span.start < k.end and k.start < span.end for k in kept):
            continue
        kept.append(span)
    return kept


def anonymize(text: str, language: str = "zh") -> dict:
    """返回 {text: 占位符替换后的出域文本, entities: [{type,start,end}]}。

    start/end 指向原文（照 PRD S4 契约示例）——取自 AnalyzerEngine 结果；
    替换用类型占位符 <TYPE>（FR-S4.1），交给 AnonymizerEngine 的 replace 算子。

    票 49（ADR 0004-3）：替换前按实体 span 切原文，把 占位符→原文 对旁路记进
    mapstore（pii_store，自持 sqlite 落盘，重启不丢）——这是受控反查口
    /pii/reveal 的粮仓。响应形状一尘不动（票 32 形状锁精神）；落盘失败让
    异常炸出去（fail-closed）：脱敏了却不留映射 = 反查口开空头支票，不如报错。
    """
    analyzer, anonymizer = _engines()
    results = analyzer.analyze(text=text, language="en", entities=ENTITY_TYPES)
    results = _drop_overlaps(results)
    get_store().record([
        {
            "placeholder": f"<{r.entity_type}>",
            "original": text[r.start:r.end],
            "entity_type": r.entity_type,
        }
        for r in results
    ])
    out = anonymizer.anonymize(
        text=text,
        analyzer_results=results,
        operators={t: OperatorConfig("replace", {}) for t in ENTITY_TYPES},
    )
    entities = [
        {"type": r.entity_type, "start": r.start, "end": r.end}
        for r in sorted(results, key=lambda r: r.start)
    ]
    return {"text": out.text, "entities": entities}
