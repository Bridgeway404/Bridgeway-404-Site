#!/usr/bin/env python3
"""
Stamp the shared header and footer into every public page.

The public site stays plain static HTML (no build step on Netlify). Shared
markup lives once in partials/header.html and partials/footer.html; each page
holds a copy between marker comments:

    <!-- partial:header -->  ...  <!-- /partial:header -->
    <!-- partial:footer -->  ...  <!-- /partial:footer -->

Run after editing a partial:  python3 tools/sync-partials.py
Use --check in CI/tests to fail when a page is out of date.

The current page's nav link gets aria-current="page" automatically.
The /admin panel is never touched.
"""
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
PARTIALS = {n: (ROOT / "partials" / f"{n}.html").read_text() for n in ("head", "header", "footer")}
PAGES = sorted(
    p for p in ROOT.rglob("*.html")
    if not any(part in {"admin", "partials", "node_modules", "supabase", "docs", "tools", ".git"} for part in p.relative_to(ROOT).parts)
    and p.parent != ROOT / "assets"
)


def url_for(path: pathlib.Path) -> str:
    rel = path.relative_to(ROOT).as_posix()
    if rel == "index.html":
        return "/"
    if rel.endswith("/index.html"):
        return "/" + rel[: -len("index.html")]
    return "/" + rel


def render(name: str, page_url: str) -> str:
    html = PARTIALS[name].strip("\n")
    # Mark the current section in the nav (exact page, or the section a sub-page lives in)
    section = "/" + page_url.strip("/").split("/")[0] + "/" if page_url.count("/") > 1 else page_url
    for target in {page_url, section}:
        html = html.replace(f'<li><a href="{target}">', f'<li><a href="{target}" aria-current="page">')
    return html


def main() -> int:
    check = "--check" in sys.argv
    stale = []
    for page in PAGES:
        text = page.read_text()
        new = text
        for name in PARTIALS:
            pat = re.compile(rf"(<!-- partial:{name} -->)(.*?)(<!-- /partial:{name} -->)", re.S)
            new = pat.sub(lambda m: m.group(1) + "\n" + render(name, url_for(page)) + "\n" + m.group(3), new)
        if new != text:
            stale.append(page.relative_to(ROOT).as_posix())
            if not check:
                page.write_text(new)
    if check:
        if stale:
            print("Out of date (run python3 tools/sync-partials.py):", *stale, sep="\n  ")
            return 1
        print(f"All {len(PAGES)} pages are in sync with partials/.")
        return 0
    print(f"Updated {len(stale)} page(s):", *stale, sep="\n  ") if stale else print("Nothing to update.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
