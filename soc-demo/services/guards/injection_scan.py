"""注入扫描（票 24）：llm-guard 启发式扫描器真引擎，接口契约照 PRD §6-M9-S3 不变。

框架红线（ADR 0002）：扫描主路径每族判定都由 llm-guard 扫描器 scan() 做出，不再有
手写匹配循环。为什么主模型不上：llm-guard 的 PromptInjection 扫描器是 deberta 文本
分类模型（HuggingFace 运行时下载 500MB+），进不了 CI——裁决口径：CI 用 llm-guard
启发式扫描器族（Regex / InvisibleText，纯模式匹配零模型），deberta 本地可选，走能力
探测 skip 并打印原因（model_available / scan_with_model，票 16 msbProbe 先例）。

扫描器映射表（llm-guard 扫描器族 ↔ 手写 6 攻击族，攻击语料族不变，详见 lessons/24-01）：
  instruction_override  → Regex（指令覆盖语料，正则原文照搬票 04，行内 (?i) 保大小写不敏感）
  authority_escalation  → Regex（权威升级语料）
  tool_call_injection   → Regex（工具调用 JSON 结构语料）
  data_exfiltration     → Regex（数据外传语料）
  prompt_exfiltration   → Regex（提示词窃取语料）
  invisible_chars       → InvisibleText（unicodedata Cf/Co/Cn 不可见字符类，比票 04 的
                           零宽字符表覆盖更宽，四布景判定等价）

权重 / THRESHOLD / CHANNEL_POLICY 是本服务的阈值配置层（票 04 起语义不变）：llm-guard
每台扫描器只回「命中与否 + 风险 1.0」，族权重求和、阈值判定、按通道处置在本层。
"""
from functools import lru_cache

from llm_guard.input_scanners import InvisibleText, Regex
from llm_guard.input_scanners.regex import MatchType as RegexMatchType

THRESHOLD = 0.5  # score 达到即判定注入（确定性：同文本同分数）

# 攻击族语料（票 04 红队实测，名单收窄防误报）；行内 (?i) 让 llm-guard 的裸
# re.compile 也带大小写不敏感——等价于票 04 的 re.IGNORECASE（ruff 纪律同款写法）
FAMILY_PATTERNS = {
    "instruction_override": [
        (r"(?i)ignore (all |any )?(previous|prior|above|earlier)|disregard (all |the )?(previous|above)"
         r"|忽略(以上|之前|上面|前面)(的)?(所有)?(指令|指示|规则|内容)")],
    "authority_escalation": [
        (r"(?i)(developer|admin|god|dan)\s*mode|已(经)?(获得|拥有)(管理员|授权|权限)"
         r"|已由(值班长|管理员|admin)批准|无需(再次)?审批|approved by (the )?(admin|duty)")],
    "tool_call_injection": [
        (r'(?i)"name"\s*:\s*"[a-z_]+"\s*,\s*"(arguments|parameters)"|调用工具\s*[a-z_]+')],
    "data_exfiltration": [
        (r"(?i)send (the )?(conversation|chat|context|api[_ ]?keys?|credentials)( history)? to"
         r"|把(对话|会话|上下文|密钥|凭证)(历史)?(发送|上传|外传|外发)到")],
    "prompt_exfiltration": [
        (r"(?i)(reveal|print|show|repeat)( the | your )?(system )?(prompt|instructions)"
         r"|(打印|输出|泄露|显示)(你的)?(系统)?提示词")],
}

# (攻击族, 权重)——权重/阈值是本服务的阈值配置层，llm-guard 族命中即计该权重
FAMILY_WEIGHTS = [
    ("instruction_override", 0.6),
    ("authority_escalation", 0.6),
    ("tool_call_injection", 0.6),
    ("data_exfiltration", 0.6),
    ("prompt_exfiltration", 0.5),
    ("invisible_chars", 0.5),
]

CHANNEL_POLICY = {
    "alert_field": "block",
    "user_input": "block",
    "kb": "strip",
    "tool_output": "flag",
}


@lru_cache(maxsize=1)
def _scanners() -> dict[str, Regex | InvisibleText]:
    """每攻击族一台 llm-guard 扫描器：5 族 Regex + invisible_chars 族 InvisibleText。

    构造一次全程复用（Regex 构造期编译正则，构造有成本）。
    """
    scanners: dict[str, Regex | InvisibleText] = {
        family: Regex(FAMILY_PATTERNS[family], redact=True, match_type="all")
        for family in FAMILY_PATTERNS
    }
    scanners["invisible_chars"] = InvisibleText()
    return scanners


def _family_hit(family: str, text: str) -> tuple[bool, int]:
    """llm-guard 扫描器判定一族：返回 (是否命中, 命中处数)。

    判定走 scanner.scan()（框架决策）；处数是审计明细——Regex 族用 llm-guard 自己的
    MatchType.match 数匹配，InvisibleText 族用「剥离前后长度差 = 剥掉的不可见字符数」。
    """
    sanitized, is_valid, _risk = _scanners()[family].scan(text)
    if is_valid:
        return False, 0
    if family == "invisible_chars":
        return True, len(text) - len(sanitized)
    pattern = FAMILY_PATTERNS[family][0]
    count = len(RegexMatchType("all").match(_compiled(pattern), text))
    return True, count


@lru_cache(maxsize=1)
def _compiled(pattern: str):
    import re
    return re.compile(pattern)


def scan(text: str, channel: str) -> dict:
    hits = []
    score = 0.0
    for family, weight in FAMILY_WEIGHTS:
        hit, count = _family_hit(family, text)
        if hit:
            hits.append({"family": family, "count": count})
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
    """剔除含命中的整行，保留干净行（kb 通道：知识条目里剔掉被投毒的段落）。

    逐行复用同族 llm-guard 扫描器判定——剔除语义（行级）是通道配置层的事，
    「哪行脏」仍由 llm-guard 说了算。
    """
    kept = [line for line in text.splitlines() if not _line_hit(line)]
    cleaned = "\n".join(kept)
    return cleaned if cleaned.strip() else ""


def _line_hit(line: str) -> bool:
    return any(_family_hit(family, line)[0] for family, _ in FAMILY_WEIGHTS)


# ---------- deberta 模型层（本地可选）：能力探测，CI 绝不在线拉 ----------

MODEL_ID = "protectai/deberta-v3-base-prompt-injection-v2"


def model_available() -> bool:
    """deberta 模型只在「已在本机 HuggingFace 缓存」时可用（local_files_only 探测，
    不发起网络下载）——CI 探测失败 → 测试 skip 并打印原因（票 16 msbProbe 先例）。"""
    try:
        from huggingface_hub import snapshot_download
        snapshot_download(MODEL_ID, local_files_only=True)
        return True
    except Exception:  # noqa: BLE001
        # 任何失败（没缓存/没装包/离线模式）都归「模型不可用」→ 测试 skip 并打印原因
        return False


def scan_with_model(text: str) -> dict | None:
    """用 llm-guard PromptInjection 扫描器（deberta 模型）复扫一段文本。

    模型不可用时返回 None（调用方自行降级到启发式主路径）；可用时返回
    {is_injection, score, scanner}——llm-guard 的 scan 契约
    （is_valid=False 即判注入，risk_score 归一到 0~1）。
    """
    if not model_available():
        return None
    from llm_guard.input_scanners import PromptInjection

    scanner = PromptInjection(threshold=0.5)
    _sanitized, is_valid, risk = scanner.scan(text)
    return {"is_injection": not is_valid, "score": risk, "scanner": "PromptInjection(deberta)"}
