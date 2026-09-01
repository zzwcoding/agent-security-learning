"""对照收官(阶段 11):同一批 campaign 用例过主线 memory_guard(Presidio)。

运行(借主线环境,勿改主线文件):
  /Users/divh/Downloads/安全评估agent/.scratch/agent-security-learning/starter-agent/.venv/bin/python comparison_presidio.py

Presidio 的 replace 算子把命中替换成 <实体类型> 标签,从输出可统计检出。
对照口径与 campaign 一致:泄露 = gold 值仍留在输出里;负例用例的替换数即误报数。
Presidio 只认它的实体清单(PERSON/EMAIL/PHONE/IP/CREDIT_CARD/CN_PHONE/CN_ID),
密钥类与语义类(住址/病历/口令)不在清单上——这正是对照要量化的"检测面"。
"""
import sys
from pathlib import Path

MAINLINE = Path("/Users/divh/Downloads/安全评估agent/.scratch/agent-security-learning/starter-agent")
sys.path.insert(0, str(MAINLINE))
from memory_guard import sanitize_messages

sys.path.insert(0, str(Path(__file__).resolve().parent))
from campaign import CASES


def presidio_sanitize(text: str) -> tuple[str, int]:
    """把一段文本包成主线 memory_guard 的消息结构,借它的 Presidio 管道消毒。"""
    clean, n = sanitize_messages([{"data": {"content": text}}])
    return clean[0]["data"]["content"], n


def main() -> None:
    print("✅ 阶段 11:同批 12 用例过主线 memory_guard(Presidio)\n")
    total_replaced = total_leak = total_fp = 0
    for case in CASES:
        out, n = presidio_sanitize(case["text"])
        gold_v = {v for _, v in case["gold"]}
        leaks = [v for v in gold_v if v in out]
        fp = n if not gold_v else max(0, n - len(gold_v))  # 负例:替换数=误报数;正例:超额≈误报
        total_replaced += n
        total_leak += len(leaks)
        total_fp += fp
        print(f"[{case['id']:17s}] gold={len(gold_v)} 替换={n} 泄露={len(leaks)} 疑似误报={fp}")
        if leaks:
            print(f"    泄露: {leaks}")
        if out != case["text"]:
            print(f"    输出: {out.splitlines()[0][:72]}")
    print(f"\n合计:替换 {total_replaced} 处 | 泄露 {total_leak} 处 | 疑似误报 {total_fp} 处")
    print("(Presidio 无延迟列:首次调用含 spaCy 模型加载,后续毫秒级,量级介于 regex 与 LLM 之间)")


if __name__ == "__main__":
    main()
