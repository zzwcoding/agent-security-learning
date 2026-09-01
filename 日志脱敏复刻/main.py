"""日志脱敏复刻——阶段 4:规则引擎下(PII 类 5 条收尾 + 类别汇总)

阶段 2-3 的引擎已能脱密钥和带校验的卡号/证件,本阶段补齐 PII 类剩余 5 条
(邮箱/IBAN/SSN/CN 手机/IPv4),规则引擎 18 条完工;main 加类别 Counter 汇总。
预期观察:PII 类样本全部命中;负例 1(13800138000 ns)被 cn_phone 误报——
这不是 bug,是负例考题在"考出"规则引擎的已知盲区,阶段 10 campaign 会量化它。
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


if __name__ == "__main__":
    main()
