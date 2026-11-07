#!/usr/bin/env python3
"""
Generate the FAQPage structured data (JSON-LD) for /faq/ from the visible questions.

Google and AI assistants only trust FAQ markup that matches what's on the page, so the
JSON-LD is never edited by hand. Edit the questions and answers in faq/index.html, then run:

    python3 tools/build-faq-schema.py           # rewrite the block between the faq-schema markers
    python3 tools/build-faq-schema.py --check   # fail if the block is out of date (used by check-site.py)

Every <details> inside a .faq block becomes one Question. The <summary> text is the question,
and the answer is the text of the <div> that follows it (links are kept as plain text).
"""
import html
import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
PAGE = ROOT / "faq" / "index.html"
START = "<!-- faq-schema: generated from the questions below by tools/build-faq-schema.py. Do not edit by hand. -->"
END = "<!-- /faq-schema -->"


def text(fragment: str) -> str:
    fragment = re.sub(r"<!--.*?-->", "", fragment, flags=re.S)
    fragment = re.sub(r"</p>\s*<p[^>]*>", " ", fragment)
    fragment = re.sub(r"<[^>]+>", "", fragment)
    return re.sub(r"\s+", " ", html.unescape(fragment)).strip()


def build(page: str) -> str:
    body = page.split("<main", 1)[1]
    items = []
    for m in re.finditer(r"<details[^>]*>\s*<summary>(.*?)</summary>\s*<div>(.*?)</div>\s*</details>", body, re.S):
        q, a = text(m.group(1)), text(m.group(2))
        items.append({"@type": "Question", "name": q, "acceptedAnswer": {"@type": "Answer", "text": a}})
    if not items:
        raise SystemExit("No FAQ questions found in faq/index.html")
    data = {
        "@context": "https://schema.org",
        "@type": "FAQPage",
        "@id": "https://bridgeway404.com/faq/#faq",
        "url": "https://bridgeway404.com/faq/",
        "about": {"@id": "https://bridgeway404.com/#business"},
        "mainEntity": items,
    }
    block = json.dumps(data, indent=2, ensure_ascii=False).replace("</", "<\\/")
    return f'{START}\n<script type="application/ld+json">\n{block}\n</script>\n{END}'


def main() -> int:
    page = PAGE.read_text()
    pattern = re.compile(re.escape(START) + r".*?" + re.escape(END), re.S)
    if not pattern.search(page):
        print("faq/index.html: faq-schema markers not found")
        return 1
    new = pattern.sub(lambda _: build(page), page)
    if "--check" in sys.argv:
        if new != page:
            print("faq/index.html: FAQ structured data is out of date — run python3 tools/build-faq-schema.py")
            return 1
        return 0
    PAGE.write_text(new)
    count = new.count('"@type": "Question"')
    print(f"Wrote FAQ structured data ({count} questions) to faq/index.html")
    return 0


if __name__ == "__main__":
    sys.exit(main())
