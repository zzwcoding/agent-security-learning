"""日志脱敏复刻——阶段 1:骨架 + 样本集

终极目标(路线图见 MISSION.md):复刻"离线规则 + 端侧 LLM + gold 基准"的日志脱敏管道,
收官与主线 memory_guard(Presidio)对照,拍板三引擎分工。
阶段 1 只立地基:把"要守护的对象"摆上桌——自造 10 条中文 Agent 日志,
密钥类 / PII 类 / 负例三类并存,打印清单与分类,让"日志是数据出海口"看得见。

纯 stdlib 零依赖,直接 python3 main.py 运行,无需 venv。
"""
from collections import Counter

from samples import SAMPLES

CATEGORY_DESC = {
    "密钥类": "API Key/令牌/私钥——Agent 日志最高频泄露,格式固定",
    "PII类": "身份证/手机号/银行卡等个人信息,格式也固定,正则可写",
    "负例": "看着像、其实不是——防误报考题,防脱敏过度毁调试价值",
}


def main() -> None:
    print("✅ 阶段 1 跑通:样本集就位(10 条中文 Agent 日志,离线零依赖)\n")
    for name, category, text in SAMPLES:
        first_line = text.splitlines()[0][:52]
        print(f"[{category}] {name}({len(text.splitlines())} 行)")
        print(f"    {first_line}")

    print("\n—— 分类汇总 ——")
    counts = Counter(category for _, category, _ in SAMPLES)
    for category, n in counts.most_common():
        print(f"  {category}:{n} 条 —— {CATEGORY_DESC[category]}")


if __name__ == "__main__":
    main()
