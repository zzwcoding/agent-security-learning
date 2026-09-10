"""llm_gateway 模块公开接口：全项目唯一的 LLM/embedding 出网口。

教学注释（阶段 3）：
- 所有 LLM 流量收口在这一个模块（PRD §0.2-3）：业务代码永远见不到厂商 SDK，
  也永远不知道对面是真 GLM 还是假 stub——接口长一个样。
- 真实后端走 OpenAI 兼容请求（智谱 v4 端点）；base_url 走环境变量可配——
  改指向椒图网关即完成"阶段一收口"（ADR 0002 预留），这是它存在的全部理由。
- fake stub 是"确定性假后端"：同输入同输出、不要网、不花钱，CI 全靠它。
  它的向量用"词级哈希叠加"伪造语义：共享词越多的文本向量越近（所以 fake 下
  "cat feline" 能命中 "cat"，但 kitty→cat 的真同义魔法只有真模型会）。
"""

import hashlib
import math
import os
import re

import httpx

_DEFAULT_BASE_URL = "https://open.bigmodel.cn/api/paas/v4"  # 智谱 GLM OpenAI 兼容端点
_backend = "glm"  # "glm"（真实）/ "fake"（确定性 stub，只许测试路径切换）

_TOKEN = re.compile(r"[a-z0-9]+|[一-鿿]")


def _cfg() -> tuple[str, str, str, str]:
    """配置面：全部走环境变量，读取时机=调用时（测试中途改 env 也生效）。"""
    return (
        os.environ.get("WEKNORA_LLM_BASE_URL", _DEFAULT_BASE_URL),
        os.environ.get("WEKNORA_LLM_API_KEY", ""),
        os.environ.get("WEKNORA_CHAT_MODEL", "glm-4-flash"),
        os.environ.get("WEKNORA_EMBED_MODEL", "embo-01"),
    )


def _embed_cfg() -> tuple[str, str, str]:
    """embed 路独立配置（2026-09-10 变更：embedding 走 MiniMax，chat 走 GLM——ADR 0003）。"""
    return (
        os.environ.get("WEKNORA_EMBED_BASE_URL", "https://api.minimaxi.com/v1"),
        os.environ.get("WEKNORA_EMBED_API_KEY", os.environ.get("WEKNORA_LLM_API_KEY", "")),
        os.environ.get("WEKNORA_EMBED_MODEL", "embo-01"),
    )


def backend_name() -> str:
    """当前后端标识（页面上标注演示走的是真 API 还是 stub）。"""
    return _backend


def use_fake_backend() -> None:
    """切到 fake stub。边界规则第 6 条：只许 tests/ 调用，演示用它是作弊。"""
    global _backend
    _backend = "fake"


def _post(url: str, api_key: str, payload: dict) -> dict:
    """真实后端的唯一 HTTP 出口（OpenAI 兼容）。测试可替换它以断言 URL/载荷。"""
    if not api_key:
        raise RuntimeError(
            "LLM API key 为空——请用 bash scripts/run-with-keychain.sh 启动"
            "（key 从 Keychain 注入环境变量；直接 streamlit run 没有 key）"
        )
    resp = httpx.post(url, json=payload, headers={"Authorization": f"Bearer {api_key}"}, timeout=60)
    resp.raise_for_status()
    return resp.json()


def _fake_embed(text: str, dim: int) -> list[float]:
    """词级哈希叠加：每个词撒一个确定性伪随机向量，文本向量=词向量之和再归一。"""
    vec = [0.0] * dim
    for tok in _TOKEN.findall(text.lower()):
        h = int(hashlib.sha256(tok.encode()).hexdigest(), 16)
        for j in range(8):  # 每个词撒 8 个维度，够稀疏够确定
            vec[h % dim] += 1.0 if (h >> (j * 8)) % 2 == 0 else -1.0
            h //= dim
    norm = math.sqrt(sum(x * x for x in vec)) or 1.0
    return [x / norm for x in vec]


def chat(messages: list[dict], *, temperature: float = 0.2) -> str:
    """对话生成；messages 为 OpenAI 兼容角色结构。"""
    if _backend == "fake":
        return f"【fake 回答】收到 {len(messages)} 条消息，末条 {len(messages[-1]['content'])} 字"
    base_url, api_key, chat_model, _ = _cfg()
    data = _post(f"{base_url}/chat/completions", api_key, {"model": chat_model, "messages": messages, "temperature": temperature})
    return data["choices"][0]["message"]["content"]


def embed(texts: list[str]) -> list[list[float]]:
    """批量嵌入：返回与输入等长的向量列表（维度随供应商：MiniMax embo-01=1536）。

    响应形状按内容自适应（duck typing）：MiniMax 给 {"vectors": [...]}，
    OpenAI 兼容给 {"data": [{"embedding": ...}]}——换供应商只改 env，不改代码。
    MiniMax 的 type="db"/"query" 非对称嵌入是有意简化：统一用 "db"（对账报告交代）。
    """
    dim = int(os.environ.get("WEKNORA_EMBED_DIM", "2048"))
    if _backend == "fake":
        return [_fake_embed(t, dim) for t in texts]
    base_url, api_key, model = _embed_cfg()
    data = _post(f"{base_url}/embeddings", api_key, {"model": model, "texts": texts, "input": texts, "type": "db"})
    if "vectors" in data:  # MiniMax 形状
        return data["vectors"]
    return [item["embedding"] for item in data["data"]]  # OpenAI 兼容形状
