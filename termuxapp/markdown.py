"""
A minimal Markdown -> HTML renderer for the offline docs viewer.

Deliberately small and dependency-free. It supports exactly what
README.md and docs/FEASIBILITY.md use: ATX headings, fenced code, inline
code, bold/italic, links, unordered/ordered lists, blockquotes, tables,
horizontal rules and paragraphs. Anything unrecognised is escaped and emitted
as a paragraph, so nothing in a doc can inject markup.
"""

from __future__ import annotations

import html
import re

_INLINE_CODE = re.compile(r"`([^`]+)`")
_BOLD = re.compile(r"\*\*([^*]+)\*\*")
_ITALIC = re.compile(r"(?<!\*)\*([^*]+)\*")
_LINK = re.compile(r"\[([^\]]+)\]\(([^)\s]+)\)")
_AUTO_URL = re.compile(r"(?<![\(>\"\w])(https?://[^\s<>\)]+)")


def _inline(text: str) -> str:
    """Escape first, then apply inline markup to the escaped text."""
    out = html.escape(text, quote=False)

    def code_sub(m: re.Match) -> str:
        return f"<code>{m.group(1)}</code>"

    out = _INLINE_CODE.sub(code_sub, out)
    out = _BOLD.sub(r"<strong>\1</strong>", out)
    out = _ITALIC.sub(r"<em>\1</em>", out)
    out = _LINK.sub(lambda m: f'<a href="{html.escape(m.group(2), quote=True)}">{m.group(1)}</a>', out)
    return out


def render(md: str) -> str:
    lines = md.replace("\r\n", "\n").split("\n")
    out: list[str] = []
    i = 0
    in_code = False
    code_buf: list[str] = []
    list_kind: str | None = None
    para: list[str] = []

    def flush_para() -> None:
        if para:
            out.append("<p>" + _inline(" ".join(para)) + "</p>")
            para.clear()

    def close_list() -> None:
        nonlocal list_kind
        if list_kind:
            out.append(f"</{list_kind}>")
            list_kind = None

    while i < len(lines):
        line = lines[i]

        if line.strip().startswith("```"):
            if in_code:
                out.append("<pre><code>" + html.escape("\n".join(code_buf)) + "</code></pre>")
                code_buf, in_code = [], False
            else:
                flush_para()
                close_list()
                in_code = True
            i += 1
            continue
        if in_code:
            code_buf.append(line)
            i += 1
            continue

        stripped = line.strip()

        if not stripped:
            flush_para()
            close_list()
            i += 1
            continue

        heading = re.match(r"^(#{1,6})\s+(.*)$", stripped)
        if heading:
            flush_para()
            close_list()
            level = len(heading.group(1))
            out.append(f"<h{level}>{_inline(heading.group(2))}</h{level}>")
            i += 1
            continue

        if re.match(r"^(?:-{3,}|\*{3,}|_{3,})$", stripped):
            flush_para()
            close_list()
            out.append("<hr>")
            i += 1
            continue

        if stripped.startswith("> "):
            flush_para()
            close_list()
            out.append(f"<blockquote>{_inline(stripped[2:])}</blockquote>")
            i += 1
            continue

        if stripped.startswith("|") and stripped.endswith("|"):
            # Collect a whole table block, then emit it.
            flush_para()
            close_list()
            block: list[str] = []
            while i < len(lines) and lines[i].strip().startswith("|"):
                block.append(lines[i].strip())
                i += 1
            out.append(_render_table(block))
            continue

        bullet = re.match(r"^[-*+]\s+(.*)$", stripped)
        ordered = re.match(r"^(\d+)[.)]\s+(.*)$", stripped)
        if bullet or ordered:
            flush_para()
            kind = "ul" if bullet else "ol"
            if list_kind != kind:
                close_list()
                out.append(f"<{kind}>")
                list_kind = kind
            content = (bullet or ordered).group(1)  # type: ignore[union-attr]
            out.append(f"<li>{_inline(content)}</li>")
            i += 1
            continue

        close_list()
        para.append(stripped)
        i += 1

    if in_code and code_buf:  # unterminated fence: still show it
        out.append("<pre><code>" + html.escape("\n".join(code_buf)) + "</code></pre>")
    flush_para()
    close_list()
    return "\n".join(out)


def _render_table(block: list[str]) -> str:
    rows = []
    for raw in block:
        cells = [c.strip() for c in raw.strip("|").split("|")]
        if all(re.match(r"^:?-{2,}:?$", c) for c in cells if c):
            continue  # the --- separator row
        rows.append(cells)
    if not rows:
        return ""
    head, *body = rows
    html_out = ["<table>", "<thead><tr>"]
    html_out += [f"<th>{_inline(c)}</th>" for c in head]
    html_out.append("</tr></thead><tbody>")
    for row in body:
        html_out.append("<tr>" + "".join(f"<td>{_inline(c)}</td>" for c in row) + "</tr>")
    html_out.append("</tbody></table>")
    return "".join(html_out)


def page(title: str, body_html: str, rtl: bool = True) -> str:
    direction = "rtl" if rtl else "ltr"
    return f"""<!doctype html>
<html lang="fa" dir="{direction}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{html.escape(title)}</title>
<style>
:root {{ color-scheme: dark; }}
body {{ margin:0; padding:24px 18px 60px; background:#0d1117; color:#e6edf3;
       font-family: Vazirmatn, Tahoma, system-ui, sans-serif; line-height:1.85; }}
main {{ max-width: 860px; margin: 0 auto; }}
h1,h2,h3 {{ line-height:1.5; }}
h1 {{ font-size:1.7rem; border-bottom:1px solid #21262d; padding-bottom:8px; }}
a {{ color:#58a6ff; }}
code {{ background:#161b22; padding:2px 6px; border-radius:5px; font-size:.9em; }}
pre {{ background:#161b22; padding:14px; border-radius:8px; overflow:auto;
      direction:ltr; text-align:left; }}
pre code {{ background:none; padding:0; }}
table {{ border-collapse:collapse; width:100%; margin:14px 0; font-size:.92rem; }}
th,td {{ border:1px solid #21262d; padding:8px 10px; text-align:right; }}
th {{ background:#161b22; }}
blockquote {{ border-right:3px solid #30363d; margin:12px 0; padding:2px 14px; color:#9da7b3; }}
nav {{ margin-bottom:18px; }}
nav a {{ display:inline-block; margin-left:10px; font-size:.9rem; }}
</style>
</head>
<body><main>
<nav><a href="/">← برنامه</a><a href="/fs/">فایل‌ها</a><a href="/docs/">مستندات</a></nav>
{body_html}
</main></body></html>"""
