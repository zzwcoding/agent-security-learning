"""任务级短时令牌(阶段 42 锚点件)——图纸三原则的最小实现。

任务级:每轮用户消息 = 一个任务,签一张票;票里声明本任务允许的工具子集。
短时效:默认 120 秒,过期即废(比"会话级 60 分钟票"细两个数量级)。
最小 scope:票内 scope 显式列举;没列的工具即使 FGA/RBAC 都放行也调不动。

与网关 FGA 闸(38)的分工:FGA 答"这个身份能不能用这个工具"(身份面,
Agent 劫持也绕不过);任务票答"这一轮任务需要用哪些工具"(行为面,约束
模型被注入后的动作空间)。两层叠加,缺一不放。

LLM 全程不接触:模型只产出工具调用;票的签发/校验都在中间件手里,
不出现在任何消息文本里。签名密钥放本地 secrets 文件(不入库)。
"""
import hashlib
import hmac
import json
import time
from pathlib import Path

_SECRET_FILE = Path(__file__).parent / ".task-token-secret"
_DEFAULT_TTL_SECONDS = 120


def _secret() -> bytes:
    """签名密钥:首次生成随机值落本地(gitignore),之后复用。"""
    if not _SECRET_FILE.exists():
        _SECRET_FILE.write_bytes(hashlib.sha256(__import__("os").urandom(32)).digest())
    return _SECRET_FILE.read_bytes()


def issue_task_token(task: str, allowed_tools: list[str], ttl_seconds: int = _DEFAULT_TTL_SECONDS) -> str:
    """为一次任务签票:JWT 形态(header.payload.signature),HS256。"""
    now = int(time.time())
    payload = {
        "task_head": task[:80],          # 任务摘要(审计可对)
        "scope": sorted(allowed_tools),  # 最小 scope:显式列举
        "iat": now,
        "exp": now + ttl_seconds,        # 短时效
    }
    header = {"alg": "HS256", "typ": "JWT"}
    b64 = lambda d: __import__("base64").urlsafe_b64encode(
        json.dumps(d, ensure_ascii=False).encode()).rstrip(b"=").decode()
    unsigned = f"{b64(header)}.{b64(payload)}"
    sig = hmac.new(_secret(), unsigned.encode(), hashlib.sha256).hexdigest()
    return f"{unsigned}.{sig}"


def verify_task_token(token: str, tool: str) -> tuple[bool, str]:
    """校验票:签名 → 过期 → scope,三关全过才放行。返回 (ok, 拒绝原因)。"""
    try:
        unsigned, sig = token.rsplit(".", 1)
        expect = hmac.new(_secret(), unsigned.encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(sig, expect):
            return False, "签名不符(票被伪造或密钥轮换)"
        payload = json.loads(__import__("base64").urlsafe_b64decode(
            unsigned.split(".")[1] + "=" * (-len(unsigned.split(".")[1]) % 4)))
        if time.time() > payload["exp"]:
            return False, f"票已过期(exp={payload['exp']},任务级短时效)"
        if tool not in payload["scope"]:
            return False, f"工具 {tool} 不在本任务 scope 内(最小授权 {payload['scope']})"
        return True, f"task='{payload['task_head'][:30]}' scope={len(payload['scope'])} 个工具"
    except Exception as e:
        return False, f"票解析失败({e}),fail closed"
