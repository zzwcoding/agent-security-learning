"""日志脱敏复刻——阶段 7:LLM 引擎对照(qwen3:0.6b 检测 Level 3 PII)

规则引擎(18 条)已完工并回归锁死;本阶段在 main 末尾追加语义引擎对照段:
对 PII 类样本调 Ollama 流式检测,打印检出项与 TTFT/吞吐指标。
对照点:同一文本,规则引擎按格式抓,LLM 按"它认为的高敏"抓——两种口径并排看。
运行前需要 Ollama 服务:brew services run ollama(临时,不注册自启)。
"""
from collections import Counter

from samples import SAMPLES
from regex_sanitizer import CATEGORY_LABELS, sanitize


def main() -> None:
    print("✅ 阶段 4 跑通:规则引擎完工(密钥类 11 + PII 类 7 = 18 条)\n")
    total = 0
    category_counts: Counter = Counter()
    for name, category, text in SAMPLES:
        redacted, findings = sanitize(text)
        total += len(findings)
        category_counts.update(f["category"] for f in findings)
        print("=" * 64)
        print(f"样本: {name}[{category}]  （命中 {len(findings)} 处）")
        print("--- 前 ---")
        print(text.rstrip())
        print("--- 后 ---")
        print(redacted.rstrip())
        for f in findings:
            label = CATEGORY_LABELS.get(f["category"], f["category"])
            print(f"   [{label}] {f['value']} -> {f['placeholder']}")

    print("\n—— 校验器演示:格式像 ≠ 真的 ——")
    for label, demo_text in [
        ("真卡号(校验码过→脱)", "card: 4111 1111 1111 1111"),
        ("假卡号(校验码不过→放行)", "card: 4111 1111 1111 1112"),
        ("真身份证(校验码对→脱)", "证件号 11010519491231002X"),
        ("假身份证(校验码错→放行)", "证件号 11010119900307721X"),
    ]:
        redacted, findings = sanitize(demo_text)
        print(f"  {label}  =>  {redacted}")

    print("\n—— 类别汇总(Counter)——")
    for cat, n in category_counts.most_common():
        print(f"  {CATEGORY_LABELS.get(cat, cat):<16} {n} 处")
    print("=" * 64)
    print(f"合计脱敏 {total} 处。规则引擎到此完工;下一站:pytest 回归(阶段 5)")

    # LLM 引擎对照(阶段 7):同一条日志,语义引擎怎么看 Level 3 PII
    from llm_engine import detect_pii
    print("\n—— LLM 引擎对照(qwen3:0.6b,需要 Ollama 服务)——")
    for name, category, text in SAMPLES:
        if category != "PII类":
            continue
        items, metrics = detect_pii(text)
        print(f"  [{name}] 检出 {len(items)} 项")
        for it in items:
            print(f"    {it.get('type')} = {it.get('value')!r}")
        print(f"    指标: TTFT {metrics['ttft_ms']}ms | 总 {metrics['total_ms']}ms | "
              f"prompt {metrics['prompt_tokens']} tok | 输出 {metrics['output_tokens']} tok"
              f"(思考 {metrics['thinking_chars']} 字)")


if __name__ == "__main__":
    main()
