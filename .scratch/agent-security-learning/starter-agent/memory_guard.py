"""记忆落库消毒(阶段 28):对话历史写进 memory.json 之前,过 Presidio Analyzer→Anonymizer。

为什么消毒点选在落库:memory.json 是唯一真实持久化的数据资产——路线 1 实证过
毒记忆能自触发,PII 落库同样会长期躺在磁盘、并在下次会话被 load_memory 回灌。
消毒只卡出口,不碰对话过程:模型当轮该看到的上下文照旧,少一层干预、少一类误伤。

Presidio 两段式:Analyzer(找)→ Anonymizer(换)。内建识别器偏英文,中文场景
的高频 PII(手机号/身份证)要自己加正则识别器——这是中文落地最重要的一课。
"""
from functools import lru_cache

from presidio_analyzer import AnalyzerEngine, Pattern, PatternRecognizer
from presidio_analyzer.nlp_engine import NlpEngineProvider
from presidio_anonymizer import AnonymizerEngine
from presidio_anonymizer.entities import OperatorConfig

# NER 模型复用 llm_guard 已下载的 en_core_web_sm(轻量,不另拉 l 套装)
_NLP_CONFIG = {"nlp_engine_name": "spacy", "models": [{"lang_code": "en", "model_name": "en_core_web_sm"}]}

# 要找的实体:内建(英文向)+ 自定义(中文向),名单收窄防误报爆炸(路线 1 教训)
_ENTITIES = ["PERSON", "EMAIL_ADDRESS", "PHONE_NUMBER", "IP_ADDRESS", "CREDIT_CARD", "CN_PHONE", "CN_ID"]


def _cn_recognizers() -> list[PatternRecognizer]:
    """内建识别器覆盖不到的中国大陆高频 PII,用正则补:手机号、身份证。"""
    return [
        PatternRecognizer(supported_entity="CN_PHONE", patterns=[
            Pattern(name="cn_mobile", regex=r"(?<!\d)1[3-9]\d{9}(?!\d)", score=0.6)]),
        PatternRecognizer(supported_entity="CN_ID", patterns=[
            Pattern(name="cn_id", regex=r"(?<!\d)\d{17}[\dXx](?!\d)", score=0.5)]),
    ]


@lru_cache(maxsize=1)
def _engines() -> tuple[AnalyzerEngine, AnonymizerEngine]:
    """模型加载慢且全程复用:单例缓存,首次调用才初始化。"""
    nlp = NlpEngineProvider(nlp_configuration=_NLP_CONFIG).create_engine()
    analyzer = AnalyzerEngine(nlp_engine=nlp, supported_languages=["en"])
    for recognizer in _cn_recognizers():
        analyzer.registry.add_recognizer(recognizer)
    return analyzer, AnonymizerEngine()


def _sanitize_text(text: str) -> tuple[str, int]:
    """对一段文本执行 Analyzer→Anonymizer,返回(消毒后文本, 替换处数)。"""
    analyzer, anonymizer = _engines()
    findings = analyzer.analyze(text=text, language="en", entities=_ENTITIES)
    if not findings:
        return text, 0
    result = anonymizer.anonymize(text=text, analyzer_results=findings,
                                  operators={e: OperatorConfig("replace", {}) for e in _ENTITIES})
    return result.text, len(findings)


def sanitize_messages(messages: list[dict]) -> tuple[list[dict], int]:
    """消毒 messages_to_dict 的输出结构:每条消息的文本内容过一遍 Presidio。

    只动 content(字符串)或 content block 里的 text 字段,其余键原样保留;
    返回(干净副本, 总替换处数)。
    """
    total = 0
    clean = []
    for msg in messages:
        msg = dict(msg)
        data = dict(msg.get("data", {}))
        content = data.get("content")
        if isinstance(content, str):
            data["content"], n = _sanitize_text(content)
            total += n
        elif isinstance(content, list):  # MCP 工具消息的 content block 列表
            new_blocks = []
            for block in content:
                if isinstance(block, dict) and isinstance(block.get("text"), str):
                    block = dict(block)
                    block["text"], n = _sanitize_text(block["text"])
                    total += n
                new_blocks.append(block)
            data["content"] = new_blocks
        msg["data"] = data
        clean.append(msg)
    return clean, total
