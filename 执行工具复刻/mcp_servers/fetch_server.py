"""fetch MCP server:HTTP GET / POST。

当前阶段(5)注释:故意裸奔——不限制目标地址、不过滤内网 IP。
它是 SSRF(服务端请求伪造)教具:Agent 可以被诱导访问任何能到达的地址。
"""
import httpx
from mcp.server.fastmcp import FastMCP

mcp = FastMCP("fetch")


@mcp.tool()
def http_get(url: str) -> str:
    """对指定 URL 发起 HTTP GET,返回状态码和响应文本(截断到 4000 字符)。"""
    r = httpx.get(url, timeout=15, follow_redirects=True)
    return f"HTTP {r.status_code}\n{r.text[:4000]}"


@mcp.tool()
def http_post(url: str, body: str = "") -> str:
    """对指定 URL 发起 HTTP POST(body 为请求体文本),返回状态码和响应文本。"""
    r = httpx.post(url, content=body, timeout=15, follow_redirects=True)
    return f"HTTP {r.status_code}\n{r.text[:4000]}"


if __name__ == "__main__":
    mcp.run()
