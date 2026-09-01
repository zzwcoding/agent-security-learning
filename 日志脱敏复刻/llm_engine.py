"""LLM 脱敏引擎——阶段 7:端侧 qwen3:0.6b 检测 Level 3 高敏 PII。

与规则引擎的分工蓝图:规则管"格式固定"的(密钥/证件/手机号,正则写得出来),
LLM 管"正则写不出"的语义盲区(病历/诊断/自然语言说出的口令/住址)。
零新增依赖:标准库 urllib 直调 Ollama /api/chat——阶段 6 裸 curl 的 Python 版。
"""
import json
import re
import time
import urllib.request

OLLAMA_URL = "http://127.0.0.1:11434/api/chat"
MODEL = "qwen3:0.6b"

# Level 3 PII 系统 prompt:类别清单与 PII_TYPES 枚举一致;值必须逐字摘抄——
# "逐字"这条是阶段 8 回填验收的前提,在这里先立规矩。
SYSTEM_PROMPT = """你是隐私保护检测器,从日志中找出 Level 3 高敏个人信息,类别限定为:
身份证号、社保号、银行卡号、护照号、驾照号、病历号、诊断、治疗、住址、口令(包括自然语言说出的口令)、金融PIN、生物特征。
只找真正的敏感值:字段名、规范用语、指标数字不算。
输出 JSON:{"pii_items": [{"type": "类别名", "value": "敏感值"}]}。
value 必须逐字复制原文中出现的子串,不许改写、不许翻译、不许加任何描述。没有就返回空数组。"""

# 类别枚举:进 schema 的 enum 后,0.6B 不再输出"敏感值"这种无区分度的泛型
# (阶段 8 挂账:占位符 [REDACTED_敏感值] 可读性差)。注意格式型类别(手机号/邮箱/
# 卡号)不在内——它们是 regex 的地盘,LLM 只管语义盲区(阶段 9 的分工)。
PII_TYPES = ["身份证号", "社保号", "银行卡号", "护照号", "驾照号", "病历号",
             "诊断", "治疗", "住址", "口令", "金融PIN", "生物特征"]

# JSON Schema:Ollama 在解码层强制模型输出合法 JSON。
# 阶段 6 冒烟实证:0.6B 裸提示词会把 JSON 包进 markdown 围栏——schema 是解药,不是装饰。
PII_SCHEMA = {
    "type": "object",
    "properties": {
        "pii_items": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "type": {"type": "string", "enum": PII_TYPES},
                    "value": {"type": "string"},
                },
                "required": ["type", "value"],
            },
        }
    },
    "required": ["pii_items"],
}


def detect_pii(text: str) -> tuple[list, dict]:
    """流式调 Ollama 检测 Level 3 PII,返回(检出项列表, 性能指标)。

    TTFT(首 token 延迟)= 请求发出到第一个 token 落地,端侧体验的关键;
    思考 token 记长度不计内容(qwen3 思考模式,阶段 6 的发现)。
    """
    request = {
        "model": MODEL,
        "messages": [{"role": "system", "content": SYSTEM_PROMPT},
                     {"role": "user", "content": text}],
        "format": PII_SCHEMA,
        "options": {"temperature": 0.1, "seed": 42},
        "stream": True,
    }
    started = time.perf_counter()
    first_token_at = content = thinking = ""
    first_seen = False
    req = urllib.request.Request(OLLAMA_URL, data=json.dumps(request).encode("utf-8"),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req) as resp:
        for line in resp:
            if not line.strip():
                continue
            chunk = json.loads(line)
            msg = chunk.get("message", {})
            thinking += msg.get("thinking") or ""
            content += msg.get("content") or ""
            if not first_seen and (msg.get("thinking") or msg.get("content")):
                first_seen, first_token_at = True, time.perf_counter()
            if chunk.get("done"):
                metrics = {
                    "ttft_ms": round((first_token_at - started) * 1000) if first_seen else 0,
                    "total_ms": round((time.perf_counter() - started) * 1000),
                    "prompt_tokens": chunk.get("prompt_eval_count") or 0,
                    "output_tokens": chunk.get("eval_count") or 0,
                    "thinking_chars": len(thinking),
                }
                break
    try:
        items = json.loads(content).get("pii_items", [])
    except json.JSONDecodeError:
        items = []  # schema 强制下不该发生;失败模式阶段 8 讲
    return items, metrics


def _value_appears_in_text(value: str, text: str) -> bool:
    """验收闸:模型的 value 必须是原文(大小写不敏感)的逐字子串,才可信。"""
    return bool(value) and value.lower() in text.lower()


def accept_and_redact(text: str, items: list) -> tuple[str, list, list]:
    """回填验收:过闸项替换为占位符;拒收项连同原因返回。

    模型说"这里有敏感信息"≠它给的值是原文里真实存在的串——幻觉、改写、
    描述性短语、标签碎片,全在"原文出现"这一步现形。这是防线:
    prompt 里的"逐字摘抄"是劝,这里是闸(阶段 7 实证:劝没用)。
    """
    accepted, rejected = [], []
    for it in items:
        value = (it.get("value") or "").strip()
        if _value_appears_in_text(value, text):
            accepted.append({**it, "value": value})
        else:
            rejected.append({**it, "value": value, "reason": "非原文子串(幻觉/改写/描述性短语)"})
    redacted = text
    # 长值先替换:防止短值先动刀把长值的匹配位置破坏掉
    for it in sorted(accepted, key=lambda x: len(x["value"]), reverse=True):
        placeholder = f"[REDACTED_{re.sub(r'\s+', '_', str(it.get('type') or 'PII')).upper()}]"
        redacted = re.sub(re.escape(it["value"]), placeholder, redacted, flags=re.IGNORECASE)
    return redacted, accepted, rejected
