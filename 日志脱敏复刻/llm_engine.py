"""LLM 脱敏引擎——阶段 7:端侧 qwen3:0.6b 检测 Level 3 高敏 PII。

与规则引擎的分工蓝图:规则管"格式固定"的(密钥/证件/手机号,正则写得出来),
LLM 管"正则写不出"的语义盲区(病历/诊断/自然语言说出的口令/住址)。
零新增依赖:标准库 urllib 直调 Ollama /api/chat——阶段 6 裸 curl 的 Python 版。
"""
import json
import time
import urllib.request

OLLAMA_URL = "http://127.0.0.1:11434/api/chat"
MODEL = "qwen3:0.6b"

# Level 3 PII 系统 prompt:只找高敏个人信息,值必须逐字摘抄——
# "逐字"这条是阶段 8 回填验收的前提,在这里先立规矩。
SYSTEM_PROMPT = """你是隐私保护检测器,从日志中找出 Level 3 高敏个人信息:
身份证号、银行卡号、病历/诊断/治疗信息、护照号、家庭住址、口令(包括用自然语言说出的口令)。
只找真正的敏感值:字段名、规范用语、指标数字不算。
输出 JSON:{"pii_items": [{"type": "类别名", "value": "敏感值"}]}。
value 必须逐字复制原文中出现的子串,不许改写、不许翻译、不许加任何描述。没有就返回空数组。"""

# JSON Schema:Ollama 在解码层强制模型输出合法 JSON。
# 阶段 6 冒烟实证:0.6B 裸提示词会把 JSON 包进 markdown 围栏——schema 是解药,不是装饰。
PII_SCHEMA = {
    "type": "object",
    "properties": {
        "pii_items": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {"type": {"type": "string"}, "value": {"type": "string"}},
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
