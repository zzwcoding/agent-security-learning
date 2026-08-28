"""最小聊天壳:没有工具、没有 LangGraph,只为了观察 rail 的行为。

数据流(双闸机 + 账单模式):
  用户输入 → [input 闸] → LLM 生成 → [output 闸] → 打印回复 + 本轮 LLM 调用明细
本阶段新增:explain() 监控回放正式上岗——每轮打印"哪几次 LLM 调用、各花多久/多少 token"。
"""
import time

from nemoguardrails import LLMRails, RailsConfig

config = RailsConfig.from_path("config")
rails = LLMRails(config)

print("✅ 阶段 5 跑通:账单模式,每轮显示 LLM 调用明细(Ctrl-C 退出)")
while True:
    try:
        user_input = input("\n你> ")
    except EOFError:  # 管道喂消息时 stdin 读完即退出,不刷 traceback
        break
    if not user_input.strip():
        continue
    t0 = time.perf_counter()
    response = rails.generate(messages=[{"role": "user", "content": user_input}])
    wall = time.perf_counter() - t0
    print(f"bot> {response['content']}")
    # explain() 列出本轮实际发生的 LLM 调用:task 是任务名(哪道闸/主生成)
    calls = rails.explain().llm_calls
    for c in calls:
        print(f"  [调用] {c.task}: {c.duration:.1f}s, {c.total_tokens} tokens")
    print(f"  [合计] {len(calls)} 次调用,墙钟 {wall:.1f}s")
