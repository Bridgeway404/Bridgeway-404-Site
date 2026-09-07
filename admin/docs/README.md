# Admin documents

PDFs served to signed-in admins from the Bridgeway Admin panel.

| File | Used by |
|---|---|
| `bridgeway-404-scheduler-sop.pdf` | `/admin/sop/` — Scheduler SOP page |

The filename above is referenced directly by `admin/sop/index.html`. If it changes,
update `PDF_URL` and both link `href`s on that page; otherwise the page shows a
"file has not been uploaded yet" notice instead of the Open / Download buttons.

These files inherit the `X-Robots-Tag: noindex, nofollow` header that `netlify.toml`
applies to `/admin/*`, and nothing on the public site links to them. Note that the
site is static, so the panel's Supabase login does not gate file downloads — anyone
with the exact URL can fetch these. Keep genuinely sensitive material out of here.
