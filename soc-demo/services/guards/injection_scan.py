"""注入扫描引擎（票 04）：确定性规则版，接口契约照 PRD §6-M9-S3。

为什么是规则不是 llm-guard 的 deberta 模型：那套要 HuggingFace 运行时下载 500MB+，
进不了 CI 也不符合本仓「确定性可测」口径——管线形状（scan→score→按通道处置）照搬
路线 1-3，引擎留作同契约替换件（决策记录见票 04）。语料家族取自路线 1-3 红队实测
（redteam-regression：promptinject Hijack / DAN / 指令覆盖族），名单收窄防误报
（路线 1 教训）。

通道处置（FR-S3.2「按通道配置」）：alert_field/user_input=block（拒答），
kb=strip（剔除命中行保留其余），tool_output=flag（仅标记，行为兜底在 S2 验票闸）。
"""
import re

THRESHOLD = 0.5  # score 达到即判定注入（确定性：同文本同分数）

FAMILIES = [
    ("instruction_override", 0.6, re.compile(
        r"ignore (all |any )?(previous|prior|above|earlier)|disregard (all |the )?(previous|above)"
        r"|忽略(以上|之前|上面|前面)(的)?(所有)?(指令|指示|规则|内容)", re.IGNORECASE)),
    ("authority_escalation", 0.6, re.compile(
        r"(developer|admin|god|dan)\s*mode|已(经)?(获得|拥有)(管理员|授权|权限)"
        r"|已由(值班长|管理员|admin)批准|无需(再次)?审批|approved by (the )?(admin|duty)", re.IGNORECASE)),
    ("tool_call_injection", 0.6, re.compile(
        r'"name"\s*:\s*"[a-z_]+"\s*,\s*"(arguments|parameters)"|调用工具\s*[a-z_]+', re.IGNORECASE)),
    ("data_exfiltration", 0.6, re.compile(
        r"send (the )?(conversation|chat|context|api[_ ]?keys?|credentials)( history)? to"
        r"|把(对话|会话|上下文|密钥|凭证)(历史)?(发送|上传|外传|外发)到", re.IGNORECASE)),
    ("prompt_exfiltration", 0.5, re.compile(
        r"(reveal|print|show|repeat)( the | your )?(system )?(prompt|instructions)"
        r"|(打印|输出|泄露|显示)(你的)?(系统)?提示词", re.IGNORECASE)),
    ("invisible_chars", 0.5, re.compile(r"[\u200b\u200c\u200d\u2060\ufeff]")),
]

CHANNEL_POLICY = {
    "alert_field": "block",
    "user_input": "block",
    "kb": "strip",
    "tool_output": "flag",
}


def scan(text: str, channel: str) -> dict:
    hits = []
    score = 0.0
    for family, weight, pattern in FAMILIES:
        found = pattern.findall(text)
        if found:
            hits.append({"family": family, "count": len(found)})
            score += weight
    score = min(1.0, round(score, 2))
    is_injection = score >= THRESHOLD
    action = "allow"
    result_text = text
    if is_injection:
        action = CHANNEL_POLICY[channel]
        if action == "strip":
            result_text = strip_lines(text)
    return {
        "is_injection": is_injection,
        "score": score,
        "scanner": "PromptInjection",
        "action": action,
        "hits": hits,
        "text": result_text,
    }


def strip_lines(text: str) -> str:
    """剔除含命中的整行，保留干净行（kb 通道：知识条目里剔掉被投毒的段落）。"""
    kept = []
    for line in text.splitlines():
        if any(p.search(line) for _, _, p in FAMILIES):
            continue
        kept.append(line)
    cleaned = "\n".join(kept)
    return cleaned if cleaned.strip() else ""
