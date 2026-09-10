"""webui 模块：Streamlit 控制台（阶段 1 先长出入库页，后续阶段逐页补齐）。

教学注释（阶段 1）：
- webui 是纯表现层：页面上点按钮 = 调 ingest 的公开接口；列表展示 = 只读查 store。
  页面里没有任何业务逻辑——业务全在管线模块里，这里只负责"让你看见"。
- Streamlit 的运行模型：每次交互（点按钮/选下拉）整个脚本从头重跑一遍，
  所以状态要么在数据库里（我们的做法），要么在 st.session_state 里。
"""

from pathlib import Path

import streamlit as st

import ingest
import store

DB_PATH = "data/app.db"
UPLOAD_DIR = Path("data/uploads")


def page_ingest() -> None:
    """入库页：上传 txt → 解析分块入库 → 文档列表 → 点开看 chunk 卡片。"""
    st.header("📥 入库")
    kbs = store.list_kbs()
    if not kbs:
        st.warning("还没有知识库，先跑种子脚本：`.venv/bin/python scripts/seed_kb.py`")
        return
    kb_id = st.selectbox("知识库", kbs, format_func=lambda k: f"{k['name']}（id={k['id']}）")["id"]

    uploaded = st.file_uploader("上传 txt 文档", type=["txt"])
    if uploaded and st.button("入库"):
        UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
        dest = UPLOAD_DIR / uploaded.name
        dest.write_bytes(uploaded.getvalue())
        try:
            doc_id = ingest.ingest_file(kb_id, str(dest))
            st.success(f"入库成功：{uploaded.name} → doc_id={doc_id}")
        except ingest.ParseError as e:
            st.error(f"解析失败（文档已置 failed 态）：{e}")

    docs = store.list_documents(kb_id)
    st.subheader(f"文档列表（{len(docs)} 份）")
    for d in docs:
        icon = "✅" if d.status == "done" else "❌"
        st.write(f"{icon} #{d.id} {d.filename}（{d.fmt}，{d.status}）")
    if docs:
        doc_id = st.selectbox("查看哪份的卡片", [d.id for d in docs])
        chunks = store.list_chunks(doc_id)
        st.subheader(f"chunk 卡片（{len(chunks)} 张）")
        for c in chunks:
            with st.expander(f"卡片 #{c.seq}（{len(c.text)} 字符）"):
                st.text(c.text)


def main() -> None:
    """Streamlit 入口。阶段标记：让你一眼看到项目跑到哪了。"""
    store.init_db(DB_PATH)
    st.title("WeKnora 复刻 · 学习控制台")
    st.write("✅ 阶段 1 跑通：上传 txt → 固定分块 → SQLite 账本 → 页面看卡片")
    page_ingest()
