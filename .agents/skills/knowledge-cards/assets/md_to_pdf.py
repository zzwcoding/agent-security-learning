#!/usr/bin/env python3
"""Markdown → HTML → PDF (via Chrome headless)

用法：
  python3 md_to_pdf.py <input.md> <output.pdf> <print.css>

使用本地 Chrome + print.css 渲染，打印友好（A4、无页眉页脚、5 级标题缩进、
段落首行缩进 2em、列表小圆点）。Chrome 打印模式会把 <hr> 当强制分页符且
CSS 无法关闭，因此脚本在 HTML 层直接去除 <hr>。
"""
import sys
import os
import subprocess
import re
import markdown
from pathlib import Path

CHROME_CANDIDATES = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",  # macOS
    "/usr/bin/google-chrome",                                          # Linux
    "/usr/bin/chromium-browser",                                       # Linux alt
]


def find_chrome():
    for p in CHROME_CANDIDATES:
        if os.path.exists(p):
            return p
    raise RuntimeError(f"Chrome not found in: {CHROME_CANDIDATES}")


def md_to_html(md_path: Path, css_path: Path) -> Path:
    md_text = md_path.read_text(encoding="utf-8")
    html_body = markdown.markdown(
        md_text,
        extensions=["fenced_code", "tables", "sane_lists", "toc"],
    )
    # 关键：Chrome 打印模式强制把 <hr> 当分页符，CSS 无法关闭——在 HTML 层去除
    html_body = re.sub(r"<hr\s*/?>", "", html_body)
    css_text = css_path.read_text(encoding="utf-8")
    html = f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>{md_path.stem}</title>
<style>
{css_text}
</style>
</head>
<body>
{html_body}
</body>
</html>
"""
    html_path = md_path.with_suffix(".html")
    html_path.write_text(html, encoding="utf-8")
    return html_path


def html_to_pdf(html_path: Path, pdf_path: Path):
    chrome = find_chrome()
    cmd = [
        chrome,
        "--headless=new",
        "--disable-gpu",
        "--no-sandbox",
        "--print-to-pdf=" + str(pdf_path),
        "--print-to-pdf-no-header",
        "--no-pdf-header-footer",
        "file://" + str(html_path.absolute()),
    ]
    subprocess.run(cmd, check=True)


def main():
    if len(sys.argv) < 4:
        print("用法: python3 md_to_pdf.py <input.md> <output.pdf> <print.css>")
        sys.exit(1)
    md_path = Path(sys.argv[1]).absolute()
    pdf_path = Path(sys.argv[2]).absolute()
    css_path = Path(sys.argv[3]).absolute()
    print(f"[1/2] MD → HTML: {md_path.name}")
    html_path = md_to_html(md_path, css_path)
    print(f"[2/2] HTML → PDF: {pdf_path.name}")
    html_to_pdf(html_path, pdf_path)
    size_kb = pdf_path.stat().st_size / 1024
    print(f"Done: {pdf_path} ({size_kb:.1f} KB)")


if __name__ == "__main__":
    main()
