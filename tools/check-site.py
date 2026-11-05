#!/usr/bin/env python3
"""
Static checks for the public Bridgeway 404 site (no browser, no dependencies).

  python3 tools/check-site.py

Checks every public page for:
  * internal links, images, scripts, stylesheets and icon references that resolve to real files
  * Netlify forms: data-netlify, matching hidden form-name, honeypot field present,
    success page exists, and the legacy field names the Zapier/Sheets lead mapping relies on
  * one <h1>, a <title>, a meta description, a canonical URL on indexable pages
  * alt text on every <img>
  * no stock-photo hosts and no leftover placeholders
  * header/footer partials in sync (tools/sync-partials.py --check)
Exit 0 = pass, 1 = failures.
"""
import pathlib
import re
import subprocess
import sys
from html.parser import HTMLParser
from urllib.parse import urlparse

ROOT = pathlib.Path(__file__).resolve().parent.parent
SKIP_DIRS = {"admin", "partials", "supabase", "docs", "tools", ".git", "node_modules"}
PAGES = sorted(p for p in ROOT.rglob("*.html")
               if not (set(p.relative_to(ROOT).parts) & SKIP_DIRS) and p.parent != ROOT / "assets")

# Field names consumed by the existing Netlify → Zapier/Make → Google Sheets lead mapping (README).
LEGACY_FIELDS = {
    "quote-request": {"customer_name", "phone", "email", "preferred_contact", "pickup_address", "service_type",
                      "items_detail", "volume_estimate", "item_location", "access_details", "timing",
                      "restricted_confirm", "additional_notes", "privacy_consent", "privacy_consent_granted"},
    "furniture-assembly-request": {"customer_name", "phone", "email", "preferred_contact", "service_area",
                                   "assembly_item_type", "num_items", "item_brand_model", "still_in_box",
                                   "has_instructions", "special_pieces", "assembly_location", "timing",
                                   "additional_notes", "privacy_consent", "privacy_consent_granted"},
}
EXPECTED_FORMS = set(LEGACY_FIELDS) | {"commercial-partner-inquiry", "service-saturdays-nomination",
                                       "service-saturdays-community"}
STOCK = ("unsplash.com", "istockphoto", "shutterstock", "gettyimages", "pexels.com")

failures = []


def fail(page, msg):
    failures.append(f"{page}: {msg}")


class Page(HTMLParser):
    def __init__(self):
        super().__init__()
        self.refs, self.imgs, self.forms, self.ids = [], [], [], set()
        self.h1 = 0
        self.title = False
        self.meta = {}
        self.canonical = None
        self._form = None

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if "id" in a:
            self.ids.add(a["id"])
        for key in ("href", "src"):
            if a.get(key):
                self.refs.append((tag, a[key]))
        if tag == "img":
            self.imgs.append(a)
        if tag == "h1":
            self.h1 += 1
        if tag == "title":
            self.title = True
        if tag == "meta":
            k = a.get("name") or a.get("property")
            if k:
                self.meta[k] = a.get("content", "")
        if tag == "link" and a.get("rel") == "canonical":
            self.canonical = a.get("href")
        if tag == "form":
            self._form = {"attrs": a, "fields": {}, "types": {}}
            self.forms.append(self._form)
        if self._form is not None and tag in ("input", "select", "textarea") and a.get("name"):
            self._form["fields"][a["name"]] = a
            self._form["types"].setdefault(a["name"], a.get("type", tag))

    def handle_endtag(self, tag):
        if tag == "form":
            self._form = None


def resolve(ref):
    path = urlparse(ref).path
    if not path or not path.startswith("/"):
        return None
    target = ROOT / path.lstrip("/")
    if path.endswith("/"):
        target = target / "index.html"
    return target


def main():
    found_forms = {}
    for page in PAGES:
        rel = page.relative_to(ROOT).as_posix()
        html = page.read_text()
        p = Page()
        p.feed(html)

        # --- references ---
        for tag, ref in p.refs:
            if ref.startswith(("http://", "https://", "mailto:", "tel:", "sms:", "#", "data:")):
                if any(s in ref for s in STOCK):
                    fail(rel, f"stock-photo URL {ref}")
                continue
            target = resolve(ref)
            if target is None:
                fail(rel, f"relative or unusual reference {ref!r} (use root-relative /paths)")
            elif not target.exists():
                fail(rel, f"broken reference {ref}")
            if "#" in ref and target is not None and target.exists() and target.suffix == ".svg":
                symbol = ref.split("#", 1)[1]
                if f'id="{symbol}"' not in target.read_text():
                    fail(rel, f"missing icon symbol #{symbol}")

        # --- SEO / a11y basics ---
        if p.h1 != 1:
            fail(rel, f"expected exactly one <h1>, found {p.h1}")
        if not p.title:
            fail(rel, "missing <title>")
        noindex = "noindex" in p.meta.get("robots", "")
        if not noindex:
            if not p.meta.get("description"):
                fail(rel, "missing meta description")
            if not (p.canonical or "").startswith("https://bridgeway404.com/"):
                fail(rel, "missing canonical URL")
        for img in p.imgs:
            if "alt" not in img:
                fail(rel, f"<img src={img.get('src')}> has no alt attribute")
        for bad in ("lorem ipsum", "TODO", "PLACEHOLDER"):
            if bad in html.split("<!-- TEAM CARDS")[0]:
                fail(rel, f"placeholder text {bad!r}")

        # --- Netlify forms ---
        for f in p.forms:
            a, fields = f["attrs"], f["fields"]
            name = a.get("name")
            if "data-netlify" not in a:
                fail(rel, f"form {name!r} lacks data-netlify")
                continue
            found_forms.setdefault(name, []).append(rel)
            if fields.get("form-name", {}).get("value") != name:
                fail(rel, f"form {name!r}: hidden form-name must equal the form name")
            hp = a.get("data-netlify-honeypot")
            if not hp or hp not in fields:
                fail(rel, f"form {name!r}: honeypot field {hp!r} missing")
            action = a.get("action", "")
            if not action or not (resolve(action) and resolve(action).exists()):
                fail(rel, f"form {name!r}: success page {action!r} does not exist")
            if (a.get("method") or "").upper() != "POST":
                fail(rel, f"form {name!r}: method must be POST")
            if "privacy_consent" not in fields:
                fail(rel, f"form {name!r}: missing privacy_consent checkbox")
            mirror = fields.get("privacy_consent", {}).get("data-consent-mirror")
            if mirror and mirror not in p.ids:
                fail(rel, f"form {name!r}: consent mirror target #{mirror} missing")
            missing = LEGACY_FIELDS.get(name, set()) - set(fields)
            if missing:
                fail(rel, f"form {name!r}: legacy CRM fields missing: {sorted(missing)}")
            if any(t == "file" for t in f["types"].values()):
                fail(rel, f"form {name!r}: file inputs need multipart + size handling — not supported here")

    for name, pages in found_forms.items():
        if len(pages) > 1:
            failures.append(f"form {name!r} is defined on several pages {pages} — keep one definition")
    for name in EXPECTED_FORMS - set(found_forms):
        failures.append(f"expected Netlify form {name!r} not found on any page")

    sync = subprocess.run([sys.executable, str(ROOT / "tools" / "sync-partials.py"), "--check"],
                          capture_output=True, text=True)
    if sync.returncode:
        failures.append(sync.stdout.strip())

    print(f"Checked {len(PAGES)} pages and {sum(len(v) for v in found_forms.values())} Netlify forms.")
    if failures:
        print(f"\n{len(failures)} problem(s):")
        for f in failures:
            print("  FAIL", f)
        return 1
    print("All public-site checks passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
