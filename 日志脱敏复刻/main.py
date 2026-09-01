"""日志脱敏复刻——阶段 2:规则引擎上(密钥类 11 条)

阶段 1 的"清单打印"退役,换成本阶段的真流程:每条样本过一遍
regex_sanitizer.sanitize(),打印 before/after 与命中明细。
预期观察:密钥类 4 条样本被脱敏;PII 类 3 条原样通过(PII 规则阶段 4 才有,
现在看到的是引擎的能力边界,不是 bug);负例 3 条零命中(密钥类规则不碰它们)。
"""
from samples import SAMPLES
from regex_sanitizer import CATEGORY_LABELS, sanitize


def main() -> None:
    print("✅ 阶段 2 跑通:密钥类 11 条规则上线,样本 before/after 对比\n")
    total = 0
    for name, category, text in SAMPLES:
        redacted, findings = sanitize(text)
        total += len(findings)
        print("=" * 64)
        print(f"样本: {name}[{category}]  （命中 {len(findings)} 处）")
        print("--- 前 ---")
        print(text.rstrip())
        print("--- 后 ---")
        print(redacted.rstrip())
        for f in findings:
            label = CATEGORY_LABELS.get(f["category"], f["category"])
            print(f"   [{label}] {f['value']} -> {f['placeholder']}")
    # 校验器能力展示(长期保留):格式像 ≠ 真的,校验算法是规则的第二道闸
    print("\n—— 校验器演示:格式像 ≠ 真的 ——")
    for label, demo_text in [
        ("真卡号(校验码过→脱)", "card: 4111 1111 1111 1111"),
        ("假卡号(校验码不过→放行)", "card: 4111 1111 1111 1112"),
        ("真身份证(校验码对→脱)", "证件号 11010519491231002X"),
        ("假身份证(校验码错→放行)", "证件号 11010119900307721X"),
    ]:
        redacted, findings = sanitize(demo_text)
        print(f"  {label}  =>  {redacted}")

    print("=" * 64)
    print(f"合计脱敏 {total} 处(PII 剩余类别阶段 4 接手)")


if __name__ == "__main__":
    main()
