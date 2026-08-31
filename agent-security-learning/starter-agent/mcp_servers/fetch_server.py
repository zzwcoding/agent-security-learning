"""fetch MCP server:HTTP GET / POST。

当前阶段(23)注释:HTTP 请求不再从宿主机裸发,每次调用拉起一台一次性
microVM,出网防御分两层:
1. VM 网络层(兜底):PUBLIC profile 默认拒私网——就算工具层被绕过、
   在 VM 里跑任意代码,内网 IP 和云元数据端点也在网络层不可达。
2. 工具层(域名白名单):URL host 不在 ALLOWED_DOMAINS 直接拒绝,fail closed。
   SDK 0.6.16 的 domain 白名单规则实测不生效(fake-IP DNS 代理只在 PUBLIC
   profile 下启动,探坑全程见 record 0024),域名白名单只能先落在工具层;
   不跟随重定向——-L 是白名单后门,一跳 301 就跳到名单外了。
"""
import shlex
import uuid
from urllib.parse import urlparse

from mcp.server.fastmcp import FastMCP
from microsandbox import Sandbox
from microsandbox.types import Network, NetworkProfile

mcp = FastMCP("fetch")

# 跑请求用的镜像,和 shell 工具同一张(python:3.12,本地已缓存)
SANDBOX_IMAGE = "python:3.12"

# 域名白名单(缺口 1 核销点):要放行新域名就往这个元组里加
ALLOWED_DOMAINS = ("httpbin.org",)


def _gate(url: str) -> str | None:
    """白名单闸:通过返回 None;不通过返回拒绝文案(fail closed,VM 都不拉起)。"""
    parts = urlparse(url)
    if parts.scheme not in ("http", "https"):
        return f"🛡️ 出网白名单拒绝:只允许 http/https,收到 scheme={parts.scheme or '(空)'}"
    host = (parts.hostname or "").lower().rstrip(".")
    if host not in ALLOWED_DOMAINS:
        return f"🛡️ 出网白名单拒绝:{host or '(无 host)'} 不在 {ALLOWED_DOMAINS}"
    return None


def _command(method: str, url: str, body: str) -> str:
    """组装 VM 内执行的 curl:URL/body 一律 shlex 转义,-w 在末尾追加状态码标记。"""
    cmd = f"curl -sS -m 15 -X {method}"
    if body:
        cmd += f" --data-binary {shlex.quote(body)}"
    return f"{cmd} -w '\\n<<<%{{http_code}}>>>' {shlex.quote(url)}"


async def _fetch(method: str, url: str, body: str) -> str:
    # 先过白名单闸,再拉 VM:一次调用一台全新 VM,用完即焚
    if reject := _gate(url):
        return reject
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
    """在一次性 microVM 里发起 HTTP GET(仅限出网白名单域名)。"""
    return await _fetch("GET", url, "")


@mcp.tool()
async def http_post(url: str, body: str = "") -> str:
    """在一次性 microVM 里发起 HTTP POST(仅限出网白名单域名)。"""
    return await _fetch("POST", url, body)


if __name__ == "__main__":
    mcp.run()
