#!/usr/bin/env python3
"""知识卡片自检脚本

用法:
  python3 check_cards.py <file_or_dir>...
  python3 check_cards.py /path/to/cards.md              # 单文件
  python3 check_cards.py /path/to/cards_dir/            # 目录下所有 .cards.md
  python3 check_cards.py /path/to/cards_dir/ --quiet    # 只输出违规

覆盖 SKILL.md 「写法规则」+「语义纪律」中的机械检查项(LLM 反复做的"数数"工作):

  C1  黑话禁令: 实验 N-M / T1-T2 / 第 N 轮 / chapter X / 阶段 X / 票 0X / 路线 N
      / starter-agent / 本项目最强 / <文件名>.py 等
  C2  单句字数 ≤50(中文按字数,英文按词)
  C3  「是什么」段每句逗号分句 ≤2
  C4  「是什么」段整段 ≤2 句
  C5  ≥3 并列数据点(用顿号聚集)应分行
  C6  自造术语首次出现应标 [自造](标题术语 vs 正文)
  C7  跨章引用同段兜底:「见 <章节号/文件名>」应在同句内附一句解释
  C8  翻译术语一致性:同文件中同一中文术语不应配不同英文
  C9  「我们的办法/对策」字段 ≤1 句(防膨胀成段);「我们怎么用」允许多句(因其
      本就承载并列数据点,SKILL 第 79 行允许分行或编号)
  C10 「我们的办法/对策」禁止空话占位(如"本关只演示,不防御")
  C11 「为什么重要」段单句应一句一观点,长并列应分行(逗号分句≤2)
  C12 卡片行数 6-10 行(SKILL 规定每卡 6-10 行)
  C13 卡片正文首句不以 `xxx` 代码片段或纯英文开头(SKILL: 先讲人话再落实例)
  C14 跨文件术语一致性:同一中文术语在所有碎片中应映射到同一英文
  C15 「是什么」段第一句必须是定义型判断句(主系表/指/属/为/等于)
  C16 「[自造]」误标检查:框架/库/行业术语严禁 [自造](SKILL 双清单)
  C17 术语括注覆盖:「是什么」段非通用术语首次出现应有定义型括注
  C18 「我们怎么用」长度软上限:>120 字警告(避免方法论卡膨胀)

不覆盖的项(需 LLM 语义判断):
  - 「是什么」是定义还是描述
  - 方法论卡是否给了具体例子
  - 读者能否读懂

输出格式(每张卡):
  file:line  [C1] 黑话: "实验 2-5" 在第 N 段第 M 句
"""
import re
import sys
from pathlib import Path
from typing import List, Tuple, Iterable


# === 配置 ===

# C1 黑话清单(正则)
BLACK_WORDS = [
    # 实验坐标
    (r"实验\s*[0-9一二三四五六七八九十]+[\-—][0-9一二三四五六七八九十]+", "C1 实验坐标 N-M"),
    (r"实验\s*[0-9一二三四五六七八九十]+(?![0-9\-—])", "C1 实验编号"),
    (r"\bT[0-9]+\b", "C1 测试编号 T1/T2"),
    (r"第\s*[0-9一二三四五六七八九十]+\s*轮", "C1 第 N 轮"),
    (r"第\s*[0-9一二三四五六七八九十]+\s*[次回]跑", "C1 第 N 次跑"),
    (r"chapter\s*[0-9]+", "C1 chapter N"),
    (r"第\s*[0-9一二三四五六七八九十]+\s*[章节]", "C1 第 N 章/节"),
    (r"第\s*三\s*章", "C1 第三章"),  # 中文数字
    # 路线编号
    (r"路线\s*[0-9一二三四五六七八九十]+", "C1 路线编号"),
    (r"阶段\s*[0-9一二三四五六七八九十]+", "C1 阶段编号"),
    (r"票\s*0[0-9]+", "C1 票编号"),
    (r"对应阶段|本阶段|后续阶段|下一阶段|当前阶段", "C1 阶段黑话"),
    # 项目内部名
    (r"starter-agent", "C1 项目内部名 starter-agent"),
    (r"防护\s*Agent", "C1 防护 Agent 黑话"),
    (r"本项目最强|本项目第一|本项目最好", "C1 本项目最强"),
    # 文件路径(典型 .py 后缀或脚本路径)
    (r"[a-zA-Z_][a-zA-Z0-9_]*\.py", "C1 .py 文件名"),
]

# C6 自造术语标记
SELF_MADE_PATTERN = re.compile(r"\[自造(?:[^\]]{0,30})?\]")
TITLE_TERM_PATTERN = re.compile(r"###\s+(.+?)\s*[(\[（]")

# 句子分割:中文句号 / 问号 / 感叹号 / 英文 . ? ! (句末)
SENTENCE_END = re.compile(r"(?<=[。！？!?])")

# 逗号分句(中文 / 英文)
COMMA_PATTERN = re.compile(r"[，,]")

# 「是什么」段头
SHENME_PATTERN = re.compile(r"是什么[:：]\s*(.*?)(?=\n\n|\n[A-Za-z\u4e00-\u9fff]+[:：]|\Z)", re.DOTALL)


def count_chinese_chars(s: str) -> int:
    """统计中文字数(英文/数字/标点不计)"""
    return sum(1 for c in s if "\u4e00" <= c <= "\u9fff")


def count_total_chars(s: str) -> int:
    """统计总字符数(含英文/数字/标点)"""
    return len(s)


def split_sentences(text: str) -> List[str]:
    """按句末标点切句"""
    text = text.strip()
    if not text:
        return []
    # 先用换行粗分,然后句末标点细分
    parts = re.split(r"\n+", text)
    sentences = []
    for p in parts:
        p = p.strip()
        if not p:
            continue
        # 按中文句末标点切
        buf = ""
        for ch in p:
            buf += ch
            if ch in "。！？!?；;":  # 分号也算句末
                sentences.append(buf.strip())
                buf = ""
        if buf.strip():
            sentences.append(buf.strip())
    return sentences


def parse_cards(content: str) -> List[Tuple[str, str]]:
    """从 markdown 内容里抽出卡片列表:[(title, body), ...]"""
    cards = []
    # 按 ### 切分(但保留 ### 行作 title)
    chunks = re.split(r"(?=^###\s)", content, flags=re.MULTILINE)
    for chunk in chunks:
        chunk = chunk.strip()
        if not chunk.startswith("### "):
            continue
        # 提取 title(第一行)
        first_line, _, rest = chunk.partition("\n")
        title = first_line[4:].strip()  # 去掉 "### "
        # 保留 rest 原文(包含标题与首段间的空行),仅去尾随空白
        # C12 行数检查依赖这里的空行存在
        cards.append((title, rest.rstrip()))
    return cards


def find_shenme_segment(body: str) -> str:
    """找到「是什么」段的内容"""
    m = SHENME_PATTERN.search(body)
    if not m:
        return ""
    return m.group(1).strip()


def check_black_words(text: str) -> List[Tuple[str, str]]:
    """C1: 黑话检查,返回 [(行内片段, 违规说明)]"""
    violations = []
    for pat, label in BLACK_WORDS:
        for m in re.finditer(pat, text):
            # 排除行内代码片段里的(粗略:跳过纯小写文件名如 "os.system")
            violations.append((m.group(0), label))
    return violations


def check_sentences(text: str) -> List[Tuple[str, str]]:
    """C2+C3: 句子长度 + 逗号分句"""
    violations = []
    sentences = split_sentences(text)
    for s in sentences:
        cn = count_chinese_chars(s)
        total = count_total_chars(s)
        # C2: 单句 ≤50 字(中文字数)
        if cn > 50:
            violations.append((s, f"C2 单句 {cn} 中文字 >50"))
        # C3: 逗号分句 ≤2
        commas = len(COMMA_PATTERN.findall(s))
        if commas > 2:
            violations.append((s, f"C3 逗号分句 {commas} >2"))
    return violations


def check_shenme(body: str) -> List[Tuple[str, str]]:
    """C3+C4: 「是什么」段检查"""
    violations = []
    seg = find_shenme_segment(body)
    if not seg:
        return violations  # 没有「是什么」段不报警(可能是技术卡用「解决什么问题」起头)
    sentences = split_sentences(seg)
    # C4: 整段 ≤2 句
    if len(sentences) > 2:
        violations.append((seg[:60] + "...", f"C4 「是什么」段 {len(sentences)} 句 >2"))
    # C3: 每句逗号分句 ≤2
    for s in sentences:
        commas = len(COMMA_PATTERN.findall(s))
        if commas > 2:
            violations.append((s, f"C3 「是什么」句逗号分句 {commas} >2"))
    return violations


def check_parallel_list(body: str) -> List[Tuple[str, str]]:
    """C5: ≥3 并列数据点(顿号聚集)应分行,并给出建议模板"""
    violations = []
    # 在「我们怎么用 / 为什么重要」段中查找顿号聚集
    for seg_name in ["我们怎么用", "为什么重要", "我们的办法", "我们的对策"]:
        m = re.search(re.escape(seg_name) + r"[:：](.*?)(?=\n\n|\n[A-Za-z\u4e00-\u9fff]+[:：]|\Z)", body, re.DOTALL)
        if not m:
            continue
        seg = m.group(1)
        # 一句话里出现 ≥2 个顿号 (= ≥3 个并列数据点) → 提示应该分行
        # SKILL 第 79 行:"≥3 个并列数据点" = 3 项 = 2 个顿号;旧版差 1
        sentences = split_sentences(seg)
        for s in sentences:
            duns = s.count("、")
            if duns >= 2 and "\n" not in s:
                # 提取顿号后的并列项给分行模板
                # 找到最后一个 "、" 之前的部分作为引导句,之后作为列表
                last_dun = s.rfind("、")
                if last_dun > 0:
                    head = s[:last_dun].split("、")[-1].strip()
                    tail_items = [x.strip() for x in s[last_dun+1:].split("、")]
                    if len(head) <= 60:
                        items_preview = " / ".join(tail_items[:4])
                        if len(tail_items) > 4:
                            items_preview += f" / ...(共 {len(tail_items)+1} 项)"
                        hint = f" → 建议分行:'{head}' 后接: · {items_preview}"
                    else:
                        hint = ""
                else:
                    hint = ""
                violations.append(
                    (s[:80], f"C5 单句含 {duns+1} 个并列数据点(顿号 {duns} 个),建议分行{hint}")
                )
    return violations


def check_self_made(title: str, body: str) -> List[Tuple[str, str]]:
    """C6: 自造术语首次出现应标 [自造]"""
    violations = []
    # 提取标题里的中文术语(去除英文括号内容)
    title_clean = re.sub(r"[(\[（].*?[)\]）]", "", title).strip()
    # 找标题里"非通用"中文术语(长度 ≥2 且不含通用词)
    title_terms = re.findall(r"[\u4e00-\u9fff]{2,}", title_clean)
    # 过滤通用词(这些不算自造)
    GENERIC_TERMS = {
        "卡片", "知识", "概念", "定义", "笔记", "汇总", "总结",
        "是什么", "攻击", "防御", "技术", "方法", "机制", "流程",
        "架构", "模型", "工具", "系统", "策略", "实验", "测试",
    }
    candidates = [t for t in title_terms if t not in GENERIC_TERMS]
    # 在正文中找这些术语的首次出现,检查是否带 [自造]
    for term in candidates:
        # 跳过已带 [自造] 的标题
        if f"{term}[自造]" in title:
            continue
        # 在正文中找 term 首次出现的位置
        for m in re.finditer(re.escape(term), body):
            start = m.start()
            # 检查后续 30 字内是否有 [自造]
            window = body[start : start + len(term) + 30]
            if "[自造]" not in window:
                # 看是否是英文术语(如 "Direct Prompt Injection" 在标题中带英文) — 跳过纯英文术语
                # 看 50 字内的上下文,确认不是被保护的引用
                violations.append(
                    (term, f"C6 术语 '{term}' 首次出现未标 [自造]")
                )
                break  # 只报一次
    return violations


def check_card(title: str, body: str) -> List[Tuple[str, str]]:
    """对一张卡做全部机械检查"""
    all_text = body
    violations = []
    violations.extend(check_black_words(all_text))
    violations.extend(check_sentences(body))  # 检查全文句子
    violations.extend(check_shenme(body))
    violations.extend(check_parallel_list(body))
    violations.extend(check_self_made(title, body))
    violations.extend(check_cross_ref_inline(body))
    violations.extend(check_translation_consistency(body))
    violations.extend(check_our_method_length(body))
    violations.extend(check_empty_placeholder(body))
    violations.extend(check_why_important(body))
    violations.extend(check_card_line_count(title, body))
    violations.extend(check_first_sentence_human(title, body))
    violations.extend(check_shenme_definition(body))
    violations.extend(check_self_made_overuse(title, body))
    violations.extend(check_term_parenthetical(body))
    violations.extend(check_usage_length(body))
    return violations


# C17 «是什么»段术语括注覆盖检查
# 检测「是什么」段已知行业/框架术语首次出现是否有定义型括注
INDUSTRY_TERMS_NEEDING_PARENTHETICAL = {
    # 中文行业术语
    "第三方数据通道", "反序列化", "完整性校验", "运行时拦截",
    "运行时校验", "来源标记", "来源校验", "签名校验",
    "OWASP", "LLM Top 10", "GenAI",
    # 框架/库英文术语(中文中以英文形态出现)
    "OpenTelemetry", "OTel", "LangChain", "LangGraph", "Langfuse",
    "CallbackHandler", "Colang", "Rails", "JSON", "YAML",
    "start_as_current_observation", "tool_calls",
}


def _has_parenthetical_nearby(text: str, start: int, end: int) -> bool:
    """检查 text 中 [start:end] 位置附近 30 字内是否有定义型信号

    三种定义型信号:
      a) 显式括注 (xxx)
      b) 中文定义结构 "X 是 Y" / "X 指 Y" — term 在 X 位 (前 5 字) 且后续 30 字内有 是/指
      c) 中文定义结构 "Y 提供 X" / "Y 通过 X" — term 之前 15 字内有 提供/通过
    """
    # a) 显式括注
    window = text[max(0, start - 15):end + 30]
    if re.search(r"[（(].{2,30}[）)]", window):
        return True
    # b) X 是 Y / X 指 Y 结构: term 在句首附近 + 后续有 是/指
    if start <= 5:
        suffix = text[end:end + 30]
        if any(kw in suffix for kw in ["是", "指", "属于", "等于", "称为", "叫做"]):
            return True
    # c) 之前有 提供/通过/来自
    short_prefix = text[max(0, start - 15):start]
    if any(kw in short_prefix for kw in ["提供", "通过", "来自", "由"]):
        return True
    # d) 之前 30 字有 是/指 (term 在中间时)
    prefix = text[max(0, start - 30):start]
    if any(kw in prefix for kw in ["是", "指", "属于", "等于", "称为", "叫做"]):
        return True
    return False


def check_term_parenthetical(body: str) -> List[Tuple[str, str]]:
    """C17: 「是什么」段已知行业术语首次出现应有定义型括注"""
    violations = []
    seg = find_shenme_segment(body)
    if not seg:
        return violations
    # 检查每个已知术语
    seen = set()
    for term in INDUSTRY_TERMS_NEEDING_PARENTHETICAL:
        if term in seen:
            continue
        m = re.search(re.escape(term), seg)
        if not m:
            continue
        seen.add(term)
        if not _has_parenthetical_nearby(seg, m.start(), m.end()):
            violations.append(
                (term, f"C17 行业术语 '{term}' 在「是什么」段首次出现无定义型括注")
            )
    return violations


# C18 「我们怎么用」长度软上限
def check_usage_length(body: str) -> List[Tuple[str, str]]:
    """C18: 「我们怎么用」中文字数 > 120 警告"""
    violations = []
    m = re.search(r"我们怎么用[:：]\s*(.*?)(?=\n\n|\n[A-Za-z\u4e00-\u9fff]+[:：]|\Z)", body, re.DOTALL)
    if not m:
        return violations
    seg = m.group(1).strip()
    cn = sum(1 for c in seg if "\u4e00" <= c <= "\u9fff")
    if cn > 120:
        violations.append(
            (seg[:30] + "...", f"C18 「我们怎么用」{cn} 字,超过 120 字软上限,建议分点")
        )
    return violations


# C15 「是什么」段第一句必须是定义型判断句
DEFINITION_VERBS = ("是", "为", "指", "属于", "等于", "称为", "叫做")
DEFINITION_STRUCT = ("→", "=", "：")  # 中文/英文冒号也算,因 SKILL 模板「是什么:」本身就是冒号


def check_shenme_definition(body: str) -> List[Tuple[str, str]]:
    """C15: 「是什么」段第一句必须是定义型判断句。

    启发式判定: 第一句必须含以下任一信号
      - 定义型动词: 是 / 为 / 指 / 属于 / 等于 / 称为 / 叫做
      - 结构化信号: → / = / 「的」 修饰语过长的术语
      - 「是什么:」段头自身已提供句式骨架,只要首句长度 ≤ 60 字就算合格
        (避免误伤长定义,如"一种针对 X 的攻击,Y 与 Z 不同,它通过..."这种合理长定义)
    """
    violations = []
    seg = find_shenme_segment(body)
    if not seg:
        return violations
    sentences = split_sentences(seg)
    if not sentences:
        return violations
    first = sentences[0].strip()
    cn_chars = sum(1 for c in first if "\u4e00" <= c <= "\u9fff")
    has_def_verb = any(v in first for v in DEFINITION_VERBS)
    has_struct = any(s in first for s in DEFINITION_STRUCT)
    # 跳过「是什么:」段头(已在 split_sentences 时被剥掉);这里只查段内
    if cn_chars > 60 and not (has_def_verb or has_struct):
        violations.append(
            (first[:60] + "...", f"C15 「是什么」首句 {cn_chars} 字且无定义型动词(是/为/指/属于/=/→),SKILL 要求第一句必须是定义型判断句")
        )
    elif cn_chars > 0 and not has_def_verb and not has_struct:
        # 短句但仍无定义型动词,可能是空头开场("用于.../一种...概念/主要作用是...")
        empty_openers = ("用于", "用来", "目的", "作用是", "提供", "帮助", "实现", "解决")
        if any(first.startswith(e) for e in empty_openers):
            violations.append(
                (first[:60], f"C15 「是什么」首句以空头词开头 '{first[:20]}...',SKILL 要求定义型开场")
            )
    return violations


# C16 [自造] 误标检查
FORBIDDEN_SELF_MADE = {
    # 框架/库自带术语
    "LangChain Callback", "Trace", "Span", "Observation",
    "CallbackHandler", "OpenTelemetry", "LangGraph", "Langfuse",
    "Rails", "Colang", "JSON",
    # 行业标准术语
    "OWASP", "SQL 注入", "反序列化", "命名实体识别",
    "LLM Top 10", "MCP", "PromptInjection",
    # 通用名词
    "攻击", "防御", "工具", "系统", "流程", "架构", "机制", "概念",
}


def check_self_made_overuse(title: str, body: str) -> List[Tuple[str, str]]:
    """C16: [自造] 误标检查。术语不在项目自造清单内却带了 [自造] 即违规。"""
    violations = []
    # 在 title 和 body 中找 [自造] 上下文
    # 模式: 任意字符 + [自造]
    for m in re.finditer(r"([一-龥A-Za-z][一-龥A-Za-z\s/\-:]{1,30})\[自造\]", title + "\n" + body):
        term = m.group(1).strip().rstrip("(/（")
        # 检查 term 是否在禁止清单(允许子串匹配,处理 "LangChain Callback" 之类空格分隔术语)
        for forbidden in FORBIDDEN_SELF_MADE:
            if forbidden in term or term in forbidden:
                violations.append(
                    (term, f"C16 行业/框架术语 '{term}' 不应带 [自造] 标记(SKILL 严禁清单)")
                )
                break
    return violations


def collect_translation_pairs(content: str) -> dict[str, set[str]]:
    """收集单文件内所有 (中文→英文) 配对"""
    pairs: dict[str, set[str]] = {}
    for m in TRANSLATION_PAIR.finditer(content):
        cn, en = m.group(1).strip(), m.group(2).strip()
        pairs.setdefault(cn, set()).add(en)
    return pairs


def check_cross_file_translation(file_pairs: dict[str, dict[str, set[str]]]) -> List[Tuple[str, str]]:
    """C14: 跨文件术语一致性
    输入: {filename: {中文: {英文集合}}}
    输出: [(snippet, label), ...]
    """
    violations = []
    # 聚合: 中文 → {来源文件 → 英文集合}
    cn_to_files: dict[str, dict[str, set[str]]] = {}
    for fname, pairs in file_pairs.items():
        for cn, ens in pairs.items():
            cn_to_files.setdefault(cn, {}).setdefault(fname, set()).update(ens)
    for cn, file_ens in cn_to_files.items():
        if len(file_ens) < 2:
            continue  # 单一来源不算不一致
        # 合并所有英文
        all_ens = set()
        for ens in file_ens.values():
            all_ens.update(ens)
        if len(all_ens) > 1:
            files_str = ", ".join(sorted(file_ens.keys())[:3])
            if len(file_ens) > 3:
                files_str += f" 等 {len(file_ens)} 文件"
            violations.append(
                (cn, f"C14 跨文件术语 '{cn}' 不一致: {sorted(all_ens)} ({files_str})")
            )
    return violations


# C7 跨章引用:「见 <章节号/文件名>」应在同句内有 ≥4 字解释
# 匹配「见 0010」「见 攻防矩阵-0009」「见 ../xxx.md」「见 file.py」
CROSS_REF_PATTERN = re.compile(
    r"见\s*("
    r"0[0-9]{3}"            # 0001-0099 章节号
    r"|攻防矩阵-0[0-9]{3}"   # 章节全名
    r"|[a-zA-Z_][\w\-]*\.(py|md)"  # 文件名
    r")"
)


def check_cross_ref_inline(body: str) -> List[Tuple[str, str]]:
    """C7: 跨章引用同段兜底
    规则: 「见 <章节号/文件名>」应在同段内附一句解释(SKILL 第 75 行明确要求
    "先说什么事,再附「见 XXX」",所以引用**前**也应有兜底)。
    以下任一条件即视为有兜底:
      (a) 引用前 30 字内累计 ≥6 个中文字
      (b) 引用后 10 字内出现分句标点(逗/分/冒/顿号)
      (c) 引用后 30 字内累计 ≥6 个中文字
    """
    violations = []
    for para in re.split(r"\n+", body):
        para = para.strip()
        if not para:
            continue
        for m in CROSS_REF_PATTERN.finditer(para):
            ref = m.group(0)
            before = para[: m.start()]
            after = para[m.end():]
            # (a) 引用前 30 字内 ≥6 中文字(说明先讲事再附引用)
            cn_before = sum(1 for c in before[-30:] if "\u4e00" <= c <= "\u9fff")
            # (b) 引用后 10 字内出现分句标点
            has_punct = bool(re.search(r"[，,；;：:、]", after[:10]))
            # (c) 引用后 30 字内 ≥6 中文字
            cn_after = sum(1 for c in after[:30] if "\u4e00" <= c <= "\u9fff")
            if not (cn_before >= 6 or has_punct or cn_after >= 6):
                violations.append(
                    (ref, f"C7 跨章引用 '{ref}' 缺同段兜底(前={cn_before}字, 后标点={has_punct}, 后中文={cn_after}字)")
                )
    return violations


# C8 翻译术语一致性:中英配对在一文件内应唯一
TRANSLATION_PAIR = re.compile(
    r"([\u4e00-\u9fff]{2,12})[（(]([A-Za-z][A-Za-z0-9\s]{1,30})[)）]"
)


def check_translation_consistency(body: str) -> List[Tuple[str, str]]:
    """C8: 同文件内同一中文术语不应配多个不同英文"""
    violations = []
    pairs: dict[str, set[str]] = {}  # 中文 → {英文集合}
    # 只扫每段第一对,避免一段多对造成同段不一致(也算违规)
    for para in re.split(r"\n+", body):
        for m in TRANSLATION_PAIR.finditer(para):
            cn, en = m.group(1).strip(), m.group(2).strip()
            pairs.setdefault(cn, set()).add(en)
    for cn, ens in pairs.items():
        if len(ens) > 1:
            violations.append(
                (cn, f"C8 术语 '{cn}' 配了 {len(ens)} 个英文: {sorted(ens)}")
            )
    return violations


# C9 「我们的办法/对策」≤1 句;「我们怎么用」允许多句(走 C2/C3/C5)
OUR_METHOD_SEG = re.compile(
    r"(我们的办法|我们的对策)[:：]\s*(.*?)(?=\n\n|\n[A-Za-z\u4e00-\u9fff]+[:：]|\Z)",
    re.DOTALL,
)
USAGE_SEG = re.compile(
    r"我们怎么用[:：]\s*(.*?)(?=\n\n|\n[A-Za-z\u4e00-\u9fff]+[:：]|\Z)",
    re.DOTALL,
)


def check_our_method_length(body: str) -> List[Tuple[str, str]]:
    """C9: 「我们的办法/对策」字段 ≤1 句(SKILL 规定只说一句话)

    「我们怎么用」允许多句,因为 SKILL 第 79 行说「我们怎么用/为什么重要」
    段如含 ≥3 个并列数据点应强制分行,而「我们怎么用」天然承载并列数据点。
    该字段的违规由 C2/C3/C5 负责(C2 句子字数、C3 逗号分句、C5 顿号聚集)。
    """
    violations = []
    for m in OUR_METHOD_SEG.finditer(body):
        seg_name = m.group(1)
        seg_text = m.group(2).strip()
        # 过滤极短的占位(如只有"未提供"3字)
        if len(seg_text) <= 8:
            continue
        sentences = split_sentences(seg_text)
        if len(sentences) > 1:
            violations.append(
                (seg_text[:60] + "...", f"C9 「{seg_name}」{len(sentences)} 句,SKILL 规定只说 1 句")
            )
    return violations


# C10 「我们的办法/对策」禁止空话占位
EMPTY_PLACEHOLDER = re.compile(
    r"("
    # 本[scope] + 否定/留作
    r"本[关项目阶段课次次节][^。\n]{0,15}(只演示|不写防御|不防|不实现|暂不|未实现|没有实现|纯演示|仅作演示)"
    # 此/该 scope
    r"|此[关阶段节][^。\n]{0,10}(暂不|不实现|不写|只演示|仅作演示)"
    # 明确语义
    r"|明确不防"
    r"|暂未实现"
    r"|暂不处理"
    r"|暂不可达"
    # 留作型
    r"|留作[^。\n]{0,8}(后续|缺口|下一[阶段项目章节])"
    r"|作为已知缺口"
    r"|作为后续缺口"
    r"|纯演示"
    # 仅/只 演示
    r"|仅作演示"
    r"|只演示"
    r")"
)


def check_empty_placeholder(body: str) -> List[Tuple[str, str]]:
    """C10: 「我们的办法/对策」字段禁止空话占位(SKILL 规定略去不写)"""
    violations = []
    for m in OUR_METHOD_SEG.finditer(body):
        seg_name = m.group(1)
        seg_text = m.group(2).strip()
        for em in EMPTY_PLACEHOLDER.finditer(seg_text):
            violations.append(
                (em.group(0), f"C10 「{seg_name}」含空话占位 '{em.group(0)}',应略去字段")
            )
    return violations


# C11 「为什么重要」段单句应一句一观点,逗号分句 ≤2
WHY_IMPORTANT_SEG = re.compile(
    r"为什么重要[:：]\s*(.*?)(?=\n\n|\n[A-Za-z\u4e00-\u9fff]+[:：]|\Z)",
    re.DOTALL,
)


def check_why_important(body: str) -> List[Tuple[str, str]]:
    """C11: 「为什么重要」段每句逗号分句 ≤2(SKILL: 禁止 4 个分号串 4 件事)"""
    violations = []
    for m in WHY_IMPORTANT_SEG.finditer(body):
        seg = m.group(1).strip()
        for s in split_sentences(seg):
            commas = len(COMMA_PATTERN.findall(s))
            if commas > 2:
                violations.append(
                    (s[:60] + "...", f"C11 「为什么重要」句逗号分句 {commas} >2")
                )
    return violations


# C12 卡片行数 6-10 行


def check_card_line_count(title: str, body: str) -> List[Tuple[str, str]]:
    """C12: 每卡 6-10 行(SKILL 规定,含空行与标题)"""
    # 拼回 title + body 然后算总行数
    full = f"### {title}\n{body}"
    lines = full.splitlines()
    # 去掉首尾空行
    while lines and not lines[0].strip():
        lines.pop(0)
    while lines and not lines[-1].strip():
        lines.pop()
    n = len(lines)
    if n < 6 or n > 10:
        return [(title, f"C12 卡片 {n} 行,SKILL 规定 6-10 行")]
    return []


# C13 卡片首句不以 `xxx` 代码片段或纯英文开头
def check_first_sentence_human(title: str, body: str) -> List[Tuple[str, str]]:
    """C13: SKILL 写法规则: 先讲人话,再落实例(术语先定义再使用)

    判定: 卡片正文首句(通常是「是什么」段开头)不应以 `xxx` 代码片段开头,
    也不应纯英文长句开头。
    """
    violations = []
    # 找「是什么」段
    seg = find_shenme_segment(body)
    if not seg:
        # 找其他段的第一个实质句子
        sentences = split_sentences(body)
        if not sentences:
            return []
        seg = sentences[0]
    # 取第一个句子
    first = split_sentences(seg)
    if not first:
        return []
    s = first[0].strip()
    # 1) 以 `xxx` 开头(代码/配置键)
    if s.startswith("`") or s.startswith("'''") or s.startswith("\"\"\""):
        violations.append(
            (s[:50] + "...", f"C13 卡片首句以代码片段开头 '{s[:30]}...',SKILL 要求先讲人话")
        )
    # 2) 首句纯英文长句(>40 字英文无中文)
    cn_chars = sum(1 for c in s if "\u4e00" <= c <= "\u9fff")
    en_chars = sum(1 for c in s if c.isascii() and c.isalpha())
    if en_chars > 40 and cn_chars < 10:
        violations.append(
            (s[:50] + "...", f"C13 卡片首句纯英文 ({en_chars} 英文字符),SKILL 要求中文为主")
        )
    return violations


def process_file(path: Path, quiet: bool = False) -> List[str]:
    """处理单个文件,返回输出行列表"""
    output = []
    content = path.read_text(encoding="utf-8")
    cards = parse_cards(content)
    if not cards:
        if not quiet:
            output.append(f"# {path}: 0 张卡")
        return output
    total_violations = 0
    for title, body in cards:
        vs = check_card(title, body)
        if vs:
            total_violations += len(vs)
            if not quiet:
                output.append(f"## {path.name}: {title}")
                for snippet, label in vs:
                    output.append(f"  - [{label}] {snippet[:60]}")
    if not quiet:
        output.insert(0, f"# {path}: {len(cards)} 张卡,{total_violations} 处违规")
        output.append("")
    elif total_violations > 0:
        output.append(f"{path}: {len(cards)} 卡 / {total_violations} 违规")
    return output


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    quiet = "--quiet" in sys.argv
    if not args:
        print("用法: python3 check_cards.py <file_or_dir>...", file=sys.stderr)
        sys.exit(1)
    all_output = []
    total_files = 0
    total_violations = 0
    # 收集跨文件翻译配对
    file_pairs: dict[str, dict[str, set[str]]] = {}
    for arg in args:
        p = Path(arg)
        if p.is_dir():
            files = sorted(p.glob("*.cards.md"))
        else:
            files = [p]
        for f in files:
            total_files += 1
            lines = process_file(f, quiet=quiet)
            all_output.extend(lines)
            # 统计违规数
            for line in lines:
                if "/ 卡 /" in line:
                    # 提取违规数
                    try:
                        n = int(line.split("/")[1].strip().split()[0])
                        total_violations += n
                    except (IndexError, ValueError):
                        pass
            # 收集翻译配对(用于 C14 跨文件检查)
            try:
                content = f.read_text(encoding="utf-8")
                file_pairs[f.name] = collect_translation_pairs(content)
            except Exception:
                pass
    # 统计违规总数(从各文件的违规行数累计)
    if not total_violations:
        for line in all_output:
            # 匹配 "- [C" 模式(每条违规一行)
            if line.startswith("  - [C"):
                total_violations += 1
    # C14 跨文件术语一致性(只在 ≥2 文件时跑)
    c14_violations = []
    if len(file_pairs) >= 2:
        c14_violations = check_cross_file_translation(file_pairs)
        if c14_violations:
            total_violations += len(c14_violations)
            all_output.append("")
            all_output.append("=== C14 跨文件术语一致性 ===")
            for snippet, label in c14_violations:
                all_output.append(f"  - [{label}] {snippet}")
    # 总结
    if quiet:
        print("\n".join(all_output))
    else:
        print("\n".join(all_output))
        print(f"\n=== 总结 ===")
        print(f"文件: {total_files} 个")
        print(f"违规: {total_violations} 处")
        if total_violations == 0:
            print("✓ 全部通过")
        else:
            print(f"✗ {total_violations} 处需修复")
    # 退出码: 有违规则非零,支持 CI / 自动化门禁
    if total_violations > 0:
        sys.exit(1)


if __name__ == "__main__":
    main()