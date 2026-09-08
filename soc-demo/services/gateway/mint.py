"""m9 铸币 py 件（票 06）：任务票 / ApprovalToken 的签发 + py 侧验签路径。

票型照 ADR 0001「搬票型不搬代码」继承 starter-agent/task_token.py（HS256 + scope
+ exp + 任务绑定）；线上 wire 形态以 fixtures/tickets/ 契约为准（票 02 产物）：

    token = <b64url(header)>.<b64url(payload)>.<hex(hmac_sha256(key, "b64h.b64p"))>
    b64url 去 padding；header/payload 序列化 = json.dumps(ensure_ascii=False) 默认分隔符
    header = {"alg": "HS256", "typ": "JWT"}；sig 是 hex 摘要（教学变体，非 JWT 标准 b64 段）

字段集照 PRD §5.8/§5.9 一字不增不减（顺序也照声明——铸票要能逐字节复现 fixture，
键序变了签名就变）。params_hash 规范化（sort_keys + 无空格分隔符）跨语言逐字节
一致。TTL：任务票 900s（决策记录 #3 统一口径）、ApprovalToken 300s（§5.9 更短）。

verify() 是 py 侧解码/验签路径，供 fixtures 契约测试与签票圆 trip 自测；now 必须
显式注入（契约 clock policy 禁 wall clock）。生产验票闸在 TS 侧 agent（票 07
verifyTicket），两端跑同一组 fixture 对冲漂移（ADR 0001 后果节）。
"""
import base64
import hashlib
import hmac
import json
import time

TASK_TTL = 900  # 决策记录 #3：统一 900s，不按 worker 差异化
APPROVAL_TTL = 300  # PRD §5.9：更短，默认 300s

# header 序列化后定死为一段常量（所有票共用，签名内容 "b64h.b64p" 里的 b64h 即它）
HEADER = base64.urlsafe_b64encode(
    json.dumps({"alg": "HS256", "typ": "JWT"}).encode()).decode().rstrip("=")


def b64u(raw: bytes) -> str:
    """b64url 去 padding（= 号补齐会进签名，两端必须一致约定去 padding）。"""
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def sign(key: bytes, unsigned: str) -> str:
    """HMAC-SHA256 的 hex 摘要（继承 task_token.py 票型，非 JWT 标准 b64 段）。"""
    return hmac.new(key, unsigned.encode(), hashlib.sha256).hexdigest()


def params_hash(params: dict) -> str:
    """参数规范化 hash：sort_keys + 无空格分隔符，跨语言逐字节一致（INV-2 的锚）。"""
    canon = json.dumps(params, ensure_ascii=False, sort_keys=True,
                       separators=(",", ":"))
    return "sha256:" + hashlib.sha256(canon.encode()).hexdigest()


def mint_task_ticket(key, *, jti, sub, case_id, run_id, scope, allowed_tools,
                     iat=None, ttl=TASK_TTL):
    """签任务票（PRD §5.8）：worker 拉起时的任务级最小 scope 票（M9-S6）。

    iat 不传取当前时间；测试冻结 iat 即可逐字节复现契约 fixture。
    返回 (token, payload)，payload 给调用方看 exp 等 claims。
    """
    iat = int(time.time()) if iat is None else iat
    payload = {  # 字段集与顺序照 PRD §5.8，一字不增不减
        "jti": jti,
        "sub": sub,
        "case_id": case_id,
        "run_id": run_id,
        "scope": list(scope),
        "allowed_tools": list(allowed_tools),
        "iat": iat,
        "exp": iat + ttl,
    }
    return _seal(key, payload), payload


def mint_approval_token(key, *, jti, approval_id, approved_by, tool, params,
                        case_id, iat=None, ttl=APPROVAL_TTL):
    """铸 ApprovalToken（PRD §5.9）：L2 动作经人批准后的一次性令牌（FR-S2.4）。

    params_hash 绑定具体参数——改参数即失效（FR-S2.2/INV-2）；used 恒以 False 铸出
    （一次性语义，焚毁登记在 M2 used_tokens 表，验票闸查表防重放）。
    """
    iat = int(time.time()) if iat is None else iat
    payload = {  # 字段集与顺序照 PRD §5.9，一字不增不减
        "jti": jti,
        "approval_id": approval_id,
        "approved_by": approved_by,
        "tool": tool,
        "params_hash": params_hash(params),
        "case_id": case_id,
        "iat": iat,
        "exp": iat + ttl,
        "used": False,
    }
    return _seal(key, payload), payload


def _seal(key: bytes, payload: dict) -> str:
    """b64url(payload) + 对 "b64h.b64p" 签 hex——签名咬的是原始字节，不是解析结果。"""
    b64p = b64u(json.dumps(payload, ensure_ascii=False).encode())
    return f"{HEADER}.{b64p}.{sign(key, f'{HEADER}.{b64p}')}"


def unseal(key: bytes, token: str) -> dict:
    """解码 + 验签，返回 payload；格式非法/签名不符 → ValueError。

    用 hmac.compare_digest 比签名（恒时比较，防逐字节试探）；签名校验在 json
    解析之前——被篡改过的字节永远没机会进解析器（fail-closed 第一关）。
    """
    parts = token.split(".")
    if len(parts) != 3:
        raise ValueError("malformed token")
    b64h, b64p, sig = parts
    if not hmac.compare_digest(sign(key, f"{b64h}.{b64p}"), sig):
        raise ValueError("signature mismatch")
    pad = "=" * (-len(b64p) % 4)
    return json.loads(base64.urlsafe_b64decode(b64p + pad))


def verify(key, token, *, tool, now, params=None, used=frozenset()):
    """py 侧验票路径：{allow, reason}（枚举照 contract.json.reasons）。

    now 必须显式注入（契约 clock policy）；used 是已焚毁 jti 集合（生产在 M2
    used_tokens 表，INV-2）。裁决顺序 fail-closed：签名 → 时效 → 焚毁 →
    scope/参数。ApprovalToken 走参数 hash 绑定（FR-S2.2），任务票走工具 scope
    （INV-3：L2 工具任何任务票都没有）；case/run 绑定与审批流的 no_ticket/
    require_approval 控制在 TS 闸（票 07）落。
    """
    try:
        payload = unseal(key, token)
    except (ValueError, KeyError, TypeError):
        # 坏格式/坏 b64/坏 json/缺字段——验票第一关任何异常都归签名不符，绝不放行
        return {"allow": False, "reason": "signature_invalid"}
    if now >= payload["exp"]:  # JWT 语义：当前时刻必须严格早于 exp
        return {"allow": False, "reason": "token_expired"}
    if payload["jti"] in used:  # 重放防线：焚毁登记过的 jti 一律 403（INV-2）
        return {"allow": False, "reason": "token_used"}
    if "params_hash" in payload:  # ApprovalToken：参数偏离 hash 即失效
        if params is None or params_hash(params) != payload["params_hash"]:
            return {"allow": False, "reason": "params_mismatch"}
    else:  # 任务票：工具必须在 allowed_tools 内
        if tool not in payload["allowed_tools"]:
            return {"allow": False, "reason": "scope_insufficient"}
    return {"allow": True, "reason": "allow", "payload": payload}
