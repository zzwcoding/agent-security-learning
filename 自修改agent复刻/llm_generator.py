"""真实 LLM 提案生成器(OpenAI 兼容端点,本项目用 MiniMax-M2)。

模型只产"提案":完整候选源码 + 自报的影响预测,连同原始请求/响应回执
(receipt)一起返回。输出只允许写进 validation/<run>/candidates/ 隔离区,
能不能进流程由模型外的同一组门槛说了算。

与参考项目的两处适配(诚实标注):
1. provider 表换成 minimax(参考项目是 ark/openrouter/openai);
2. MiniMax-M2 是推理模型,回复自带 <think>...</think> 思考块,
   _extract_json 先剥思考块再提 JSON;max_tokens 相应放大。
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import time
from typing import Any, Dict

from openai import OpenAI

from evolution import candidate_from_source


def _strip_think(text: str) -> str:
    """剥掉推理模型的思考块;没写完的思考块(截断)也一并剥掉。"""
    text = re.sub(r"<think>.*?</think>", "", text, flags=re.S)
    return re.sub(r"<think>.*$", "", text, flags=re.S)


def _extract_json(text: str) -> dict[str, Any]:
    cleaned = _strip_think(text.strip())
    cleaned = re.sub(r"^```(?:json)?\s*|\s*```$", "", cleaned, flags=re.I)
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", cleaned, re.S)
        if not match:
            raise
        return json.loads(match.group(0))


def _client(provider: str) -> tuple[OpenAI, dict[str, Any]]:
    if provider == "minimax":
        key = os.getenv("MINIMAX_API_KEY")
        if not key:
            raise RuntimeError("MINIMAX_API_KEY is required (use scripts/run-with-keychain.sh)")
        base = "https://api.minimaxi.com/v1"
        return OpenAI(api_key=key, base_url=base), {
            "provider": provider, "endpoint": base + "/chat/completions",
            "credential_env": "MINIMAX_API_KEY",
        }
    key = os.getenv("OPENAI_API_KEY")
    if not key:
        raise RuntimeError("OPENAI_API_KEY is required")
    return OpenAI(api_key=key), {
        "provider": provider, "endpoint": "https://api.openai.com/v1/chat/completions",
        "credential_env": "OPENAI_API_KEY",
    }


def generate_with_openai(
    stable_source: str,
    diagnosis: Dict[str, Any],
    model: str | None = None,
    *,
    provider: str = "minimax",
    seed: int = 8501,
    rejected_history: list[dict[str, Any]] | None = None,
) -> Dict[str, Any]:
    client, backend = _client(provider)
    selected_model = model or os.getenv("MINIMAX_MODEL", "MiniMax-M2")
    prompt = f"""You are the Coding Agent in a controlled self-modification pipeline.

Modify only the supplied retry-policy module. Preserve both public function
signatures and retry behavior for temporary failures. Permanent failures
(retryable=false or a listed permanent code) must not be retried and must open
the circuit on the first occurrence. Update VERSION to a candidate version.
Do not import modules, access files, or alter validation/release logic.

Before the source, predict the intended impact. Return JSON only:
{{"impact_prediction": {{"non_retryable_calls": {{"before": "up to 4", "after": 1}},
"temporary_timeout_recovery_rate": {{"before": 1.0, "after": 1.0}}}},
"source": "the complete Python module"}}

Failure diagnosis:
{json.dumps(diagnosis, ensure_ascii=False, indent=2)}

Previously rejected candidates (do not repeat their failure):
{json.dumps(rejected_history or [], ensure_ascii=False, indent=2)}

Stable module:
{stable_source}
"""
    request = {
        "model": selected_model,
        "messages": [{"role": "user", "content": prompt}],
        "temperature": 0,
        "seed": seed,
        "max_tokens": 8192,
        "response_format": {"type": "json_object"},
    }
    started = time.perf_counter()
    response = client.chat.completions.create(**request)
    elapsed = time.perf_counter() - started
    raw = response.model_dump(mode="json", exclude_none=True)
    # 推理模型的思考块计入 max_tokens:被截断时正文是空的,提前给出明确错误
    if response.choices[0].finish_reason == "length":
        raise RuntimeError("LLM response truncated by max_tokens (think block ate the budget); raise it")
    payload = _extract_json(response.choices[0].message.content or "")
    source = str(payload.get("source", ""))
    if not source.endswith("\n"):
        source += "\n"
    usage = raw.get("usage") or {}
    cost = usage.get("cost")
    receipt = {
        "backend": {**backend, "model": selected_model, "credential_value_recorded": False},
        "request": request,
        "response": raw,
        "request_sha256": hashlib.sha256(json.dumps(request, sort_keys=True).encode()).hexdigest(),
        "response_sha256": hashlib.sha256(json.dumps(raw, sort_keys=True).encode()).hexdigest(),
        "elapsed_seconds": round(elapsed, 6),
        "usage": {
            "prompt_tokens": int(usage.get("prompt_tokens") or 0),
            "completion_tokens": int(usage.get("completion_tokens") or 0),
            "total_tokens": int(usage.get("total_tokens") or 0),
            "provider_reported_cost_usd": float(cost) if cost is not None else None,
            "cost_qualification": (
                "provider-native usage.cost" if cost is not None
                else "provider did not expose monetary cost; no price was guessed"
            ),
        },
    }
    return candidate_from_source(
        stable_source,
        source,
        impact_prediction=payload.get("impact_prediction") or {},
        generator_metadata={
            "generator": "real_llm_coding_agent", "model": selected_model,
            "provider": provider, "seed": seed, "api_calls": 1, "receipt": receipt,
        },
    )
