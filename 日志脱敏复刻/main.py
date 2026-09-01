"""日志脱敏复刻——阶段 9:混合管道(regex 先行,LLM 脱敏后补扫)

规则引擎(18 条)与 LLM 引擎(阶段 7-8 带验收闸)都已就位;本阶段接成一条管道:
regex 微秒级先扫全量,LLM 在脱敏后文本上补扫语义盲区(总跑一遍防混合样本漏脱,
占位符污染有防御)。可观察变化:每条样本打印两段引擎各干了什么。
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

    # 混合管道(阶段 9):regex 先行,LLM 脱敏后补扫——每条样本打印两段引擎干了什么
    from pipeline import hybrid_sanitize
    print("\n—— 混合管道(regex 先行,LLM 补扫语义盲区)——")
    for name, category, text in SAMPLES:
        r = hybrid_sanitize(text)
        print(f"  [{category}] {name}")
        print(f"      regex 命中 {r['regex_hits']} 处({r['regex_ms']:.3f}ms)"
              f" + LLM 补扫(给 {r['llm_given']} 收 {r['llm_kept']} 拒 {r['llm_rejected']},"
              f"{r['llm_ms']:.0f}ms)")
        print(f"      结果: {r['redacted'].splitlines()[0][:64]}")


if __name__ == "__main__":
    main()
