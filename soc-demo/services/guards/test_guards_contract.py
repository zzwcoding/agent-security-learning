"""票 32 验收 1：guards 响应形状跨语言契约（生产端闸）。

契约唯一事实是 fixtures/guards/contract.json（TS 消费端
services/agent/src/guards-contract.test.ts 读同一份，仿 fixtures/tickets 先例）。
本文件只对「生产端」表态：真打 HTTP 面，断言响应键集一字不增不减、字段类型、
阈值语义、通道枚举与通道处置策略逐项咬合契约——谁改形状不改契约，这端先红。
"""
import json
from pathlib import Path

from app import app
from fastapi.testclient import TestClient
from injection_scan import CHANNEL_POLICY, THRESHOLD

ROOT = Path(__file__).parents[2]
CONTRACT = json.loads(
    (ROOT / "fixtures" / "guards" / "contract.json").read_text(encoding="utf-8")
)
client = TestClient(app)


def scan(text: str, channel: str) -> dict:
    r = client.post("/scan/injection", json={"text": text, "channel": channel})
    assert r.status_code == 200, r.text
    return r.json()


def test_channel_enum_and_policy_match_contract():
    """通道枚举 ≡ 契约 channels ≡ 契约 channel_policy 键集；处置值都在 action 值域内。"""
    assert sorted(CONTRACT["channels"]) == sorted(CHANNEL_POLICY), "通道枚举漂移"
    assert CHANNEL_POLICY == CONTRACT["channel_policy"], "通道处置策略漂移"
    assert set(CHANNEL_POLICY) == set(CONTRACT["channel_policy"])
    assert set(CONTRACT["channel_policy"].values()) <= set(CONTRACT["actions"])


def test_threshold_and_contract_self_consistency():
    """阈值 ≡ 契约；契约自洽：TS 消费端声明的消费键 ⊆ 响应键集。"""
    assert THRESHOLD == CONTRACT["scan_injection"]["threshold"], "阈值漂移"
    declared = set(CONTRACT["scan_injection"]["response_fields"])
    consumed = set(CONTRACT["client_only"]["consumed_fields"])
    assert consumed <= declared, "契约自洽坏了：消费端要读的键不在响应形状里"
    assert set(CONTRACT["scan_injection"]["hits_item_fields"]) == {"family", "count"}


def test_response_shape_exact_on_every_channel():
    """每个样本 × 每通道：响应键集一字不增不减（票 02 先例），类型/阈值/通道策略全咬合。"""
    declared = set(CONTRACT["scan_injection"]["response_fields"])
    threshold = CONTRACT["scan_injection"]["threshold"]
    scanner_name = CONTRACT["scan_injection"]["scanner_name"]
    for sample in CONTRACT["samples"]:
        for channel in CONTRACT["channels"]:
            out = scan(sample["text"], channel)
            assert set(out) == declared, (
                f"{sample['name']}/{channel}: 响应键集 ≠ 契约"
                f"（多 {sorted(set(out) - declared)} / 少 {sorted(declared - set(out))}）"
            )
            assert isinstance(out["is_injection"], bool), f"{sample['name']}/{channel}"
            assert isinstance(out["score"], (int, float)), f"{sample['name']}/{channel}"
            assert 0.0 <= out["score"] <= 1.0, f"{sample['name']}/{channel}"
            assert out["scanner"] == scanner_name, f"{sample['name']}/{channel}"
            assert out["action"] in CONTRACT["actions"], f"{sample['name']}/{channel}"
            assert isinstance(out["hits"], list), f"{sample['name']}/{channel}"
            for item in out["hits"]:
                assert set(item) == set(CONTRACT["scan_injection"]["hits_item_fields"])
            assert isinstance(out["text"], str), f"{sample['name']}/{channel}"
            # 期望结果 + 阈值语义 + 通道策略
            assert out["is_injection"] == sample["expect"]["is_injection"], (
                f"{sample['name']}/{channel}: 判定与契约样本不符"
            )
            assert (out["score"] >= threshold) == out["is_injection"], (
                f"{sample['name']}/{channel}: score 与阈值的语义漂移"
            )
            if out["is_injection"]:
                assert out["action"] == CONTRACT["channel_policy"][channel], (
                    f"{sample['name']}/{channel}: action 不遵通道策略"
                )
            else:
                assert out["action"] == "allow", f"{sample['name']}/{channel}"
            # text 语义：strip 清洗必动原文，其余通道原样透传
            if out["action"] == "strip" and out["is_injection"]:
                assert out["text"] != sample["text"], f"{sample['name']}/{channel}: strip 未清洗"
            else:
                assert out["text"] == sample["text"], f"{sample['name']}/{channel}: text 被偷改"


def test_request_shape_requires_text_and_channel():
    """请求形状照契约 request_fields：缺 channel 必失败（TestClient 默认直抛
    服务端 KeyError；raise_server_exceptions=False 时退化为 5xx——两条路都算失败）。"""
    try:
        r = client.post("/scan/injection", json={"text": "hello"})
        assert r.status_code >= 500, "缺 channel 竟然放行了——请求形状漂移"
    except KeyError:
        pass  # 直抛形态：处理函数拿不到必需键就炸，契约语义不变
