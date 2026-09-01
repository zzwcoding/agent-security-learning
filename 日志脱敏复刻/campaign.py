"""campaign 基准(阶段 10):三引擎在同一批 gold 用例上跑分。

用数据回答"哪种引擎管哪类",不靠感觉。指标:
- 精确率 P:检出的值里有多少真是 gold(1 - 误报率)
- 召回率 R:gold 里有多少被检出(1 - 漏报率)
- utility:1 - 误脱字符/非敏感字符(脱过头毁了多少调试价值)
- 泄露:gold 值仍留在脱敏后文本里的条数(该脱没脱=事故)
- 延迟:每用例毫秒(regex 微秒级 vs LLM 秒级,分工的成本面)

gold 全为虚构假值;负例 gold=[]。decoy(形状巧合的陷阱)是防过拟合的考题。
"""
import time

from llm_engine import accept_and_redact, detect_pii
from regex_sanitizer import sanitize

CASES = [
    {"id": "structured_cn", "text": "客户身份证号11010519491231002X，手机号13812345678。",
     "gold": [("身份证号", "11010519491231002X"), ("手机号", "13812345678")]},
    {"id": "structured_us", "text": "SSN 123-45-6789; Visa 4111 1111 1111 1111; 工单号 123-45-6780 不是社保号。",
     "gold": [("社保号", "123-45-6789"), ("信用卡号", "4111 1111 1111 1111")]},
    {"id": "credentials", "text": "postgres://alice:S3cret-Pw@db.internal:5432/payments 连接失败; 重试 token=Retry-Token-99",
     "gold": [("口令", "S3cret-Pw"), ("口令", "Retry-Token-99")]},
    {"id": "natural_password", "text": "用户说：我网银的登录口令是‘Blue moon over river 77’，请帮我记住。",
     "gold": [("口令", "Blue moon over river 77")]},
    {"id": "address", "text": "请把补办证件寄到 上海市浦东新区桂花路333弄12号502，收件人电话 13812345678。",
     "gold": [("住址", "上海市浦东新区桂花路333弄12号502"), ("手机号", "13812345678")]},
    {"id": "medical", "text": "门诊记录：患者王某某，病历号 MRN-789456，确诊二期乳腺癌，周五开始多柔比星化疗。",
     "gold": [("病历号", "MRN-789456"), ("诊断", "二期乳腺癌"), ("治疗", "多柔比星")]},
    {"id": "passport", "text": "旅客护照号 P987654321 于 2027-04-09 到期；订单号 P987654320 与该旅客无关。",
     "gold": [("护照号", "P987654321")]},
    {"id": "iban_sku", "text": "汇款账号 GB29NWBK60161331926819 已收到；SKU 4429853328 与该账户无关。",
     "gold": [("银行卡号", "GB29NWBK60161331926819")]},
    {"id": "email_bearer", "text": "Authorization: Bearer fakeBearerToken1234567890; 通知 alice.wang@example.com。",
     "gold": [("口令", "fakeBearerToken1234567890"), ("邮箱", "alice.wang@example.com")]},
    {"id": "negative_numbers", "text": "性能指标：延迟 13800138000 ns，构建号 4111111111111112，型号 XR-7003。均不涉及个人。",
     "gold": []},
    {"id": "negative_language", "text": "口令策略：口令字段必须至少包含 12 个字符。绝不要记录用户的真实口令。",
     "gold": []},
    {"id": "mixed_context", "text": "客服记录：来电 13912345678 说订单 13912345679 明天发货，并提供了密码: hunter2xyz。",
     "gold": [("手机号", "13912345678"), ("口令", "hunter2xyz")]},
]

# regex 的英文类别 → gold 的中文类别;密钥类按语义归桶,与 LLM 的"口令"可对齐
REGEX_ALIAS = {
    "private_key": "私钥", "jwt": "口令", "url_credential": "口令",
    "aws_access_key": "API密钥", "github_token": "API密钥", "slack_token": "API密钥",
    "google_api_key": "API密钥", "api_key": "API密钥", "bearer_token": "口令",
    "basic_auth": "口令", "secret_assignment": "口令", "email": "邮箱",
    "credit_card": "信用卡号", "iban": "银行卡号", "us_ssn": "社保号",
    "cn_id_card": "身份证号", "cn_phone": "手机号", "ip_address": "IP地址",
}


def regex_run(text: str) -> tuple[list, str, float]:
    started = time.perf_counter()
    redacted, findings = sanitize(text)
    ms = (time.perf_counter() - started) * 1000
    pred = [(REGEX_ALIAS.get(f["category"], f["category"]), f["value"]) for f in findings]
    return pred, redacted, ms


def llm_run(text: str) -> tuple[list, str, float]:
    items, metrics = detect_pii(text)
    redacted, accepted, _ = accept_and_redact(text, items)
    pred = [(i.get("type"), i.get("value")) for i in accepted if i.get("value")]
    return pred, redacted, float(metrics["total_ms"])


def hybrid_run(text: str) -> tuple[list, str, float]:
    started = time.perf_counter()
    redacted, findings = sanitize(text)
    items, _ = detect_pii(redacted)
    items = [i for i in items if "redacted" not in (i.get("value") or "").lower()]
    redacted, accepted, _ = accept_and_redact(redacted, items)
    ms = (time.perf_counter() - started) * 1000
    pred = [(REGEX_ALIAS.get(f["category"], f["category"]), f["value"]) for f in findings]
    pred += [(i.get("type"), i.get("value")) for i in accepted if i.get("value")]
    return pred, redacted, ms


def evaluate(case: dict, pred: list, redacted: str, ms: float) -> dict:
    gold = {(t, v) for t, v in case["gold"]}
    gold_v = {v for _, v in gold}
    pred_v = {v for _, v in pred}
    tp = len(gold_v & pred_v)
    wasted = sum(len(v) for v in pred_v - gold_v)
    return {
        "p": tp / len(pred_v) if pred_v else 1.0,
        "r": tp / len(gold_v) if gold_v else 1.0,
        "utility": max(0.0, 1 - wasted / max(1, len(case["text"]) - sum(len(v) for v in gold_v))),
        "leaks": len([v for v in gold_v if v in redacted]),
        "ms": ms,
    }


def main() -> None:
    print("✅ 阶段 10:campaign 三引擎基准(12 用例,含负例与 decoy;需 Ollama)\n")
    totals = {"regex": [], "llm": [], "hybrid": []}
    for i, case in enumerate(CASES, 1):
        print(f"[{i}/{len(CASES)}] {case['id']}(gold {len(case['gold'])} 项)")
        for name, runner in (("regex", regex_run), ("llm", llm_run), ("hybrid", hybrid_run)):
            pred, redacted, ms = runner(case["text"])
            row = evaluate(case, pred, redacted, ms)
            totals[name].append(row)
            print(f"   {name:7s} P={row['p']:.2f} R={row['r']:.2f} U={row['utility']:.2f} "
                  f"泄露={row['leaks']} {row['ms']:.1f}ms")

    print("\n—— 汇总(12 用例均值)——")
    print(f"{'引擎':8s} {'精确率P':>8s} {'召回率R':>8s} {'utility':>8s} {'总泄露':>6s} {'均延迟':>10s}")
    for name, rows in totals.items():
        n = len(rows)
        print(f"{name:8s} {sum(r['p'] for r in rows)/n:>9.2f} {sum(r['r'] for r in rows)/n:>9.2f} "
              f"{sum(r['utility'] for r in rows)/n:>9.2f} {sum(r['leaks'] for r in rows):>7d} "
              f"{sum(r['ms'] for r in rows)/n:>8.1f}ms")
    print("\n读表提示:P 低=误报多(负例/decoy 考砸),R 低=漏报多(该类不在能力圈),"
          "泄露>0=该脱没脱,utility 低=脱过头毁调试价值。")


if __name__ == "__main__":
    main()
