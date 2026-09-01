"""规则脱敏引擎——阶段 2:密钥类 11 条规则。

为什么先做密钥类:Agent 日志里最高频的泄露是密钥不是身份证——Agent 调工具要带
token、连数据库要有 DSN、部署要有平台令牌,每一步都被日志如实记录;身份证只在
客服/表单场景出现。密钥泄露的后果也最直接:攻击者拿到日志等于拿到钥匙,不用破门。

每条规则是一个五元组:(类别, 占位符, 正则, 取值分组号, 校验器):
- 占位符带类别标签(如 [REDACTED_JWT]):日志脱敏后仍要给人看,"这里原本是个 JWT"
  比一个无差别的 [REDACTED] 的调试价值高得多——脱敏不该摧毁可排障性。
- 取值分组号:0=整段命中都脱;N=只脱第 N 个捕获组。捕获组让 `password=xxx` 只脱
  值不脱键名——键名是结构,值才是秘密。多个可选组用元组(见口令赋值规则)。
- 校验器(阶段 3 接上):格式像不等于真的,用算法再验一道砍误报。
"""
import re
from typing import Dict, List, Tuple


def _luhn_ok(number: str) -> bool:
    """Luhn 校验:信用卡号末位是按前各位算出的校验位,随便编的数字串过不了。
    作用是砍误报——13~19 位数字串(订单号、时间戳)长得像卡号的一大把。"""
    digits = [int(c) for c in number if c.isdigit()]
    if not 13 <= len(digits) <= 19:
        return False
    checksum, parity = 0, len(digits) % 2
    for i, d in enumerate(digits):
        if i % 2 == parity:
            d *= 2
            if d > 9:
                d -= 9
        checksum += d
    return checksum % 10 == 0


def _cn_id_ok(value: str) -> bool:
    """中国大陆二代身份证(18 位)校验码:前 17 位加权求和 mod 11 查表得第 18 位。
    道理同 Luhn:格式对(17 位数字+X)不等于号码真,校验码对不上就放行。"""
    s = value.upper()
    if len(s) != 18 or not s[:17].isdigit():
        return False
    weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2]
    check_codes = "10X98765432"
    total = sum(int(s[i]) * weights[i] for i in range(17))
    return check_codes[total % 11] == s[17]

# 规则表顺序即优先级:编号小的高优先级。重叠时高优先级先到先得。
# 五元组:(类别, 占位符, 正则, 取值分组号, 校验器)——校验器为 None 表示正则命中即收。
_RULES = [
    ("private_key", "[REDACTED_PRIVATE_KEY]", re.compile(
        r"-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----"
        r"[\s\S]*?(?:-----END (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----|(?=\Z))"), 0, None),
    ("jwt", "[REDACTED_JWT]", re.compile(
        r"eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}"), 0, None),
    ("url_credential", "[REDACTED_URL_CRED]", re.compile(
        r"://[^\s:/@]*:([^\s@]+)@"), 1, None),
    ("aws_access_key", "[REDACTED_AWS_KEY]", re.compile(
        r"\bAKIA[0-9A-Z]{16}\b"), 0, None),
    ("github_token", "[REDACTED_GITHUB_TOKEN]", re.compile(
        r"\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{20,})\b"), 0, None),
    ("slack_token", "[REDACTED_SLACK_TOKEN]", re.compile(
        r"\bxox[baprs]-[A-Za-z0-9-]{10,}\b"), 0, None),
    ("google_api_key", "[REDACTED_GOOGLE_API_KEY]", re.compile(
        r"\bAIza[0-9A-Za-z_-]{35}\b"), 0, None),
    ("api_key", "[REDACTED_API_KEY]", re.compile(
        r"\bsk-[A-Za-z0-9_-]{20,}\b"), 0, None),
    ("bearer_token", "[REDACTED_BEARER_TOKEN]", re.compile(
        r"(?i)\bBearer\s+([A-Za-z0-9._~+/=-]{10,})"), 1, None),
    ("basic_auth", "[REDACTED_BASIC_AUTH]", re.compile(
        r"(?i)\bAuthorization\s*:\s*Basic\s+([A-Za-z0-9+/=]{4,})"), 1, None),
    ("secret_assignment", "[REDACTED_SECRET]", re.compile(
        r"(?i)(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|auth|credential)[\"']?\s*[=:]\s*"
        r"(?:\"([^\"]{4,})\"|'([^']{4,})'|([^\s\"',}]{4,}))"), (1, 2, 3), None),
    ("credit_card", "[REDACTED_CREDIT_CARD]", re.compile(
        r"\b(?:\d[ -]?){13,19}\b"), 0, _luhn_ok),
    ("cn_id_card", "[REDACTED_ID_CARD]", re.compile(
        r"\b\d{17}[\dXx]\b"), 0, _cn_id_ok),
]

CATEGORY_LABELS = {
    "private_key": "私钥 / 证书", "jwt": "JWT 令牌", "url_credential": "连接串凭据",
    "aws_access_key": "AWS 访问密钥", "github_token": "GitHub 令牌",
    "slack_token": "Slack 令牌", "google_api_key": "Google API Key",
    "api_key": "API Key (sk-)", "bearer_token": "Bearer 令牌",
    "basic_auth": "Basic 认证", "secret_assignment": "口令 / 密钥赋值",
    "credit_card": "信用卡号", "cn_id_card": "身份证号",
}


def sanitize(text: str) -> Tuple[str, List[Dict]]:
    """全部规则各扫一遍,校验器再筛一道,重叠时按规则表顺序先到先得,按位置重建脱敏文本。"""
    hits: List[Dict] = []
    for priority, (category, placeholder, pattern, group, validator) in enumerate(_RULES):
        groups = group if isinstance(group, tuple) else (group,)
        for m in pattern.finditer(text):
            span = next((m.span(g) for g in groups if m.span(g)[0] >= 0), None)
            if span is None:
                continue
            value = text[span[0]:span[1]]
            if validator and not validator(value):
                continue  # 格式像但校验不过(假卡号/假证件号)——放行,不误伤
            hits.append({"category": category, "placeholder": placeholder, "value": value,
                         "start": span[0], "end": span[1], "priority": priority})

    # 裁决:按 (优先级, 位置) 排序,与已收下的命中重叠的丢弃——防止同一段被两条规则重复替换
    hits.sort(key=lambda h: (h["priority"], h["start"]))
    accepted: List[Dict] = []
    for h in hits:
        if any(h["start"] < a["end"] and a["start"] < h["end"] for a in accepted):
            continue
        accepted.append(h)

    # 重建:按位置拼回——命中段换占位符,其余原样保留
    accepted.sort(key=lambda h: h["start"])
    parts, last = [], 0
    for h in accepted:
        parts.append(text[last:h["start"]])
        parts.append(h["placeholder"])
        last = h["end"]
    parts.append(text[last:])
    findings = [{k: h[k] for k in ("category", "value", "placeholder", "start", "end")} for h in accepted]
    return "".join(parts), findings
