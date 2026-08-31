"""fetch MCP server:HTTP GET / POST。

当前阶段(27)注释:出网白名单(阶段 23)之上再加凭证分发——请求里的
{{SECRET:NAME}} 占位符由本进程按"目标域名 → 允许的密钥名"策略表替换,
真值在分发瞬间从 macOS Keychain 现取,用完即弃。Agent 和模型全程只见
占位符;名字没在策略表点过名、或 Keychain 里取不到 = 整个请求拒绝
(fail closed),绝不带着未替换的占位符出网。执行面不变:每次调用仍是
一台一次性 microVM(网络层 PUBLIC profile 兜底)。
"""
import re
import shlex
import subprocess
import uuid
from urllib.parse import urlparse

from mcp.server.fastmcp import FastMCP
from microsandbox import Sandbox
from microsandbox.types import Network, NetworkProfile

mcp = FastMCP("fetch")

# 跑请求用的镜像,和 shell 工具同一张(python:3.12,本地已缓存)
SANDBOX_IMAGE = "python:3.12"

# 出网白名单(缺口 1 核销点):要放行新域名就往这个元组里加
ALLOWED_DOMAINS = ("httpbin.org",)

# 凭证策略表(阶段 27,与出网白名单同处):域名 → 允许携带的密钥名。
# 密钥值不进任何文件和环境(fetch_server 是 Agent 子进程,会继承环境!),
# 分发时按名从 Keychain 现取(security 命令),这是"最后一刻注入"。
CREDENTIAL_POLICY: dict[str, tuple[str, ...]] = {
    "httpbin.org": ("DEMO_API_KEY",),
}

_SECRET_RE = re.compile(r"\{\{SECRET:([A-Z0-9_]+)\}\}")


def _gate(url: str) -> str | None:
    """白名单闸:通过返回 None;不通过返回拒绝文案(fail closed,VM 都不拉起)。"""
    parts = urlparse(url)
    if parts.scheme not in ("http", "https"):
        return f"🛡️ 出网白名单拒绝:只允许 http/https,收到 scheme={parts.scheme or '(空)'}"
    host = (parts.hostname or "").lower().rstrip(".")
    if host not in ALLOWED_DOMAINS:
        return f"🛡️ 出网白名单拒绝:{host or '(无 host)'} 不在 {ALLOWED_DOMAINS}"
    return None


def _keychain_read(name: str) -> str:
    """按名从 macOS Keychain 取密钥值;取不到抛 KeyError,由上层转成拒绝。"""
    proc = subprocess.run(
        ["security", "find-generic-password", "-s", name, "-w"],
        capture_output=True, text=True,
    )
    if proc.returncode != 0:
        raise KeyError(name)
    return proc.stdout.strip()


def _resolve_secrets(domain: str, url: str, body: str) -> tuple[str, str] | str:
    """把 url/body 里的 {{SECRET:NAME}} 换成 Keychain 真值。

    授权规则:NAME 必须在 CREDENTIAL_POLICY[该域名] 里点过名——密钥不但
    要存在,还要"授权去这个域名"才给。返回 (url, body) 或拒绝文案。
    """
    allowed = CREDENTIAL_POLICY.get(domain, ())

    def substitute(text: str) -> str:
        def repl(match: re.Match) -> str:
            name = match.group(1)
            if name not in allowed:
                raise PermissionError(f"密钥 {name} 未授权给域名 {domain}")
            return _keychain_read(name)

        return _SECRET_RE.sub(repl, text)

    try:
        return substitute(url), substitute(body)
    except KeyError as e:
        return f"🛡️ 凭证拒绝:Keychain 里没有 {e.args[0]}(fail closed,请求未发出)"
    except PermissionError as e:
        return f"🛡️ 凭证拒绝:{e}(fail closed,请求未发出)"


def _command(method: str, url: str, body: str) -> str:
    """组装 VM 内执行的 curl:URL/body 一律 shlex 转义,-w 在末尾追加状态码标记。"""
    cmd = f"curl -sS -m 15 -X {method}"
    if body:
        cmd += f" --data-binary {shlex.quote(body)}"
    return f"{cmd} -w '\\n<<<%{{http_code}}>>>' {shlex.quote(url)}"


async def _fetch(method: str, url: str, body: str) -> str:
    # 先过白名单闸,再解凭证,最后才拉 VM:一次调用一台全新 VM,用完即焚
    if reject := _gate(url):
        return reject
    host = (urlparse(url).hostname or "").lower().rstrip(".")
    resolved = _resolve_secrets(host, url, body)
    if isinstance(resolved, str):
        return resolved  # 凭证闸的拒绝文案
    url, body = resolved
    name = f"fetch-{uuid.uuid4().hex[:8]}"
    async with await Sandbox.create(
        name=name, image=SANDBOX_IMAGE, ephemeral=True,
        network=Network.from_profiles(NetworkProfile.PUBLIC),  # 私网默认拒:网络层兜底
    ) as sb:
        out = await sb.shell(_command(method, url, body), timeout=30)
    text = (out.stdout_text + out.stderr_text).strip()
    if out.exit_code != 0:  # VM 内请求失败(DNS/连接/超时),错误原样带回
        return f"(VM 内请求失败,退出码 {out.exit_code}){text[:400]}"
    raw, _, code = text.rpartition("<<<")  # -w 的状态码标记在响应体之后,取最后一段
    return f"HTTP {code.rstrip('>')}\n{raw.strip()[:4000]}"


@mcp.tool()
async def http_get(url: str) -> str:
    """在一次性 microVM 里发起 HTTP GET(仅限白名单域名,支持 {{SECRET:NAME}} 占位符)。"""
    return await _fetch("GET", url, "")


@mcp.tool()
async def http_post(url: str, body: str = "") -> str:
    """在一次性 microVM 里发起 HTTP POST(仅限白名单域名,支持 {{SECRET:NAME}} 占位符)。"""
    return await _fetch("POST", url, body)


if __name__ == "__main__":
    mcp.run()
