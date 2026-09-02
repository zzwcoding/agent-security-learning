"""阶段 47:薄 HTTP 层——把路线 3 收官形态 Agent 包成一个 /chat 服务。

唯一的存在理由是红队:garak(RestGenerator)和 PyRIT(对照靶)需要一个 HTTP 攻击面。
本层只做协议转换,防线零改动——输入护栏、串联闸(任务票/D4/法官)、工具返回两级、
输出护栏、审计三面、记忆装载三闸全部照走;请求经全局锁串行化,因为 agent.py 的
CURRENT_ROUND/CURRENT_TASK 是 CLI 单线程假设。

会话模型:不给 session_id 就走默认线程(与 CLI 同一条 "cli-session",记忆装载三闸
在环路里,退出时照常 save_memory);给 session_id 就是隔离的干净房间(多轮攻击编排用)。
本文件是红队资产,不进 Agent 的 Docker 镜像。
"""
import asyncio
from contextlib import asynccontextmanager
from datetime import datetime, timezone

from fastapi import FastAPI
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langchain_openai import ChatOpenAI
from langfuse import Langfuse
from langfuse.langchain import CallbackHandler
from llm_guard.input_scanners import PromptInjection
from llm_guard.output_scanners import Sensitive
from pydantic import BaseModel

import agent as A  # 防线与锚点件全部复用:build_agent/装载三闸/哈希链/任务票/审计
from config import LLM_API_KEY, LLM_BASE_URL, LLM_MODEL, WORKSPACE_DIR

DEFAULT_THREAD = "cli-session"  # 与 agent.py 的 THREAD 一致:记忆装载/保存的主线

# 轨迹里认这两种前缀为"被闸拦下"(串联闸 🛑 / 护栏 🛡️ 的拒信统一格式)
DENY_PREFIXES = ("🛑", "🛡️")


class ChatRequest(BaseModel):
    message: str
    session_id: str | None = None  # 缺省 = 默认线程;多轮攻击编排按会话隔离时显式传


class ChatResponse(BaseModel):
    response: str
    session_id: str
    blocked: bool = False           # 输入护栏拦截(消息没进图)
    tool_calls: list[dict] = []     # 轨迹:每次调用的 name/args/结果头/是否被闸拦——PyRIT 断言用


def _bootstrap(app: FastAPI) -> None:
    """在 worker 线程里完成全部重活(build_agent 内部 asyncio.run,不能泡在请求循环里)。

    与 CLI main() 的启动序列逐项对齐:同一份扫描器配置、同一个 Langfuse mask、
    同一条装载三闸链路——HTTP 入口不享有任何绕过。
    """
    WORKSPACE_DIR.mkdir(exist_ok=True)
    llm = ChatOpenAI(base_url=LLM_BASE_URL, api_key=LLM_API_KEY, model=LLM_MODEL)
    print("正在加载护栏模型……")
    app.state.injection_scanner = PromptInjection()
    app.state.output_scanner = Sensitive(
        entity_types=["CREDIT_CARD", "CRYPTO", "US_SSN", "US_BANK_NUMBER", "IBAN_CODE"])
    app.state.langfuse_client = Langfuse(mask=A.mask_secrets)
    app.state.langfuse_handler = CallbackHandler()
    app.state.llm = llm
    app.state.agent = A.build_agent(llm, app.state.injection_scanner,
                                    app.state.output_scanner, app.state.langfuse_client)
    asyncio.run(A.load_memory_async(app.state.agent, app.state.injection_scanner, llm))
    print("薄 HTTP 层就绪:POST /chat {message, session_id?}")


@asynccontextmanager
async def lifespan(app: FastAPI):
    await asyncio.to_thread(_bootstrap, app)
    yield
    app.state.langfuse_client.flush()
    A.save_memory(app.state.agent)  # 与 CLI 退出同一动作:消毒+完整性信封落盘


app = FastAPI(title="starter-agent-chat", lifespan=lifespan)
_round_lock = asyncio.Lock()  # agent.py 的 CURRENT_* 全局是单线程假设,HTTP 侧串行化


@app.get("/healthz")
def healthz():
    return {"ok": hasattr(app.state, "agent")}


async def _chat_round(app: FastAPI, text: str, thread_id: str) -> ChatResponse:
    """一轮 ReAct,镜像 agent.ask() 但线程可指定、轨迹落进响应(不再只打印)。"""
    A.CURRENT_ROUND["why"] = text
    A.CURRENT_TASK["token"] = A.issue_task_token(text, A.infer_scope(text))
    config = {"configurable": {"thread_id": thread_id},
              "callbacks": [app.state.langfuse_handler],
              "metadata": {"audit.when": datetime.now(timezone.utc).isoformat(), "audit.why": text}}
    trajectory: list[dict] = []
    answer = ""
    with app.state.langfuse_client.start_as_current_observation(
            name="http-round", as_type="chain",
            metadata={"audit.when": config["metadata"]["audit.when"], "audit.why": text}):
        async for chunk in app.state.agent.astream(
                {"messages": [HumanMessage(text)]}, config=config, stream_mode="values"):
            msg = chunk["messages"][-1]
            if isinstance(msg, AIMessage) and msg.tool_calls:
                for tc in msg.tool_calls:
                    trajectory.append({"name": tc["name"], "args": tc["args"],
                                       "result_head": None, "denied": None})
            elif isinstance(msg, ToolMessage):
                head = A._text(msg.content)[:200]
                if trajectory:  # 本 agent 工具调用串行,挂到最近一次调用上即可
                    trajectory[-1]["result_head"] = head
                    trajectory[-1]["denied"] = head.startswith(DENY_PREFIXES)
            elif isinstance(msg, AIMessage) and msg.content:
                answer = msg.content
    return ChatResponse(response=answer, session_id=thread_id, tool_calls=trajectory)


@app.post("/chat", response_model=ChatResponse)
async def chat(req: ChatRequest):
    thread_id = req.session_id or DEFAULT_THREAD
    async with _round_lock:
        # 输入护栏:与 CLI 同一条闸——拦截发生在图外,手动补 guardrail 观测后立即上报
        _, safe, score = app.state.injection_scanner.scan(req.message)
        if not safe:
            with app.state.langfuse_client.start_as_current_observation(
                    as_type="guardrail", name="input-guard-block",
                    input=req.message, output="拦截:未进入 ReAct 图",
                    level="WARNING", metadata={"injection_score": score, "entry": "http"}):
                pass
            app.state.langfuse_client.flush()
            return ChatResponse(response=f"🛡️ 输入护栏拦截:检测到提示注入(分数 {score})",
                                session_id=thread_id, blocked=True)
        return await _chat_round(app, req.message, thread_id)
