#!/usr/bin/env python3
"""
Verify the Bridgeway 404 link-preview (Open Graph / Twitter) metadata.

Serves the site over real HTTP, fetches each page with a social-scraper
User-Agent, parses the returned HTML, and asserts that the share preview
resolves to the branded Bridgeway 404 card — never to a stock photo.

Run:  python3 tools/verify-social-metadata.py
Exit: 0 = all checks passed, 1 = something is wrong.
"""
import functools
import http.server
import pathlib
import socketserver
import struct
import sys
import threading
import urllib.request
from html.parser import HTMLParser

ROOT = pathlib.Path(__file__).resolve().parent.parent
PROD = "https://bridgeway404.com"
CARD = "/assets/bridgeway404-social-preview-v2.png"
CARD_URL = PROD + CARD

# Any host that would mean a stock photo is being advertised as the preview.
STOCK_HOSTS = ("images.unsplash.com", "unsplash.com", "istockphoto",
               "shutterstock", "gettyimages", "pexels.com")

PAGES = {
    "/": "index.html",
    "/thank-you.html": "thank-you.html",
    "/privacy-policy.html": "privacy-policy.html",
}

REQUIRED = [
    ("og:image", CARD_URL),
    ("og:image:secure_url", CARD_URL),
    ("og:image:type", "image/png"),
    ("og:image:width", "1200"),
    ("og:image:height", "630"),
    ("og:title", None),
    ("og:description", None),
    ("og:url", None),
    ("twitter:card", "summary_large_image"),
    ("twitter:image", CARD_URL),
]

failures, checks = [], 0


def check(ok, label):
    global checks
    checks += 1
    print(f"  {'PASS' if ok else 'FAIL'}  {label}")
    if not ok:
        failures.append(label)


class MetaParser(HTMLParser):
    """Collects <meta> tags the way a scraper does: property= and name=."""

    def __init__(self):
        super().__init__()
        self.meta = {}
        self.imgs = []

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "meta":
            key = a.get("property") or a.get("name")
            if key and "content" in a:
                self.meta.setdefault(key, a["content"])
        elif tag == "img" and a.get("src"):
            self.imgs.append(a["src"])


def png_size(path):
    with open(path, "rb") as fh:
        head = fh.read(33)
    assert head[:8] == b"\x89PNG\r\n\x1a\n", "not a PNG"
    return struct.unpack(">II", head[16:24])


def serve():
    handler = functools.partial(http.server.SimpleHTTPRequestHandler,
                                directory=str(ROOT))
    handler.log_message = lambda *a, **k: None
    httpd = socketserver.TCPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, httpd.server_address[1]


def fetch(port, path):
    req = urllib.request.Request(
        f"http://127.0.0.1:{port}{path}",
        headers={"User-Agent": "facebookexternalhit/1.1 (+http://www.facebook.com/"
                               "externalhit_uatext.php)"})
    with urllib.request.urlopen(req, timeout=10) as r:
        return r.status, r.read().decode("utf-8", "replace")


def main():
    httpd, port = serve()
    try:
        print(f"\nServing {ROOT} on 127.0.0.1:{port}\n")

        print("[1] Share card asset")
        card_path = ROOT / CARD.lstrip("/")
        check(card_path.is_file(), f"{CARD} exists on disk")
        if card_path.is_file():
            w, h = png_size(card_path)
            check((w, h) == (1200, 630), f"card is 1200x630 (got {w}x{h})")
            kb = card_path.stat().st_size / 1024
            check(kb < 1024, f"card is under 1 MB (got {kb:.0f} KB)")
            req = urllib.request.Request(f"http://127.0.0.1:{port}{CARD}")
            with urllib.request.urlopen(req, timeout=10) as r:
                status, ctype, body = r.status, r.headers.get("Content-Type"), r.read()
            check(status == 200, f"card served over HTTP (got {status})")
            check(ctype == "image/png", f"card served as image/png (got {ctype})")
            check(body[:8] == b"\x89PNG\r\n\x1a\n", "served bytes are a real PNG")

        for path, fname in PAGES.items():
            print(f"\n[{fname}] fetched as facebookexternalhit")
            status, html = fetch(port, path)
            check(status == 200, f"{path} returns 200")

            p = MetaParser()
            p.feed(html)

            for key, expected in REQUIRED:
                got = p.meta.get(key)
                if expected is None:
                    check(bool(got), f"{key} present")
                else:
                    check(got == expected, f"{key} == {expected!r} (got {got!r})")

            # The whole point: no metadata path may advertise a stock photo.
            bad = {k: v for k, v in p.meta.items()
                   if ("image" in k or "og:" in k or "twitter:" in k)
                   and any(s in v.lower() for s in STOCK_HOSTS)}
            check(not bad, f"no stock-photo URL in any og:/twitter: tag ({bad or 'clean'})")

            # og:image must be absolute and on the production origin.
            oi = p.meta.get("og:image", "")
            check(oi.startswith("https://"), "og:image is an absolute https URL")
            check(oi.startswith(PROD + "/"), f"og:image is on {PROD}")

            # Scrapers fall back to in-page images only when og:image is absent.
            stock_in_body = [s for s in p.imgs
                             if any(h in s.lower() for h in STOCK_HOSTS)]
            print(f"    note: {len(stock_in_body)} stock <img> in body — "
                  f"unreachable as preview because og:image is set")

        print(f"\n{checks - len(failures)}/{checks} checks passed")
        if failures:
            print("\nFAILED:")
            for f in failures:
                print("  -", f)
            return 1
        print("Share preview resolves to the branded Bridgeway 404 card.")
        return 0
    finally:
        httpd.shutdown()


if __name__ == "__main__":
    sys.exit(main())
