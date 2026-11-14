"""Helpers for the agent-research tests: seed the HTTP cache with fixture pages, build tiny PDFs."""
import io
import json

from backend import settings
from backend.data.http_cache import cache_key

RETRIEVED = "2026-11-14T12:00:00+00:00"


def seed_page(url: str, body: bytes | str) -> None:
    """Write a page into the HTTP cache exactly as cached_get(url, fmt="bytes") would have."""
    d = settings.CACHE_DIR / "http"
    d.mkdir(parents=True, exist_ok=True)
    key = cache_key(url, None)
    (d / f"{key}.bin").write_bytes(body.encode() if isinstance(body, str) else body)
    (d / f"{key}.meta.json").write_text(json.dumps({"url": url, "params": None, "retrieved_at": RETRIEVED}))


def seed_json(url: str, params: dict | None, obj) -> None:
    """Write a JSON response into the HTTP cache exactly as cached_get(url, params) would have (ArcGIS stand-ins)."""
    d = settings.CACHE_DIR / "http"
    d.mkdir(parents=True, exist_ok=True)
    key = cache_key(url, params)
    (d / f"{key}.json").write_text(json.dumps(obj))
    (d / f"{key}.meta.json").write_text(json.dumps({"url": url, "params": params, "retrieved_at": RETRIEVED}))


def pdf(pages: list[str]) -> bytes:
    """A minimal valid PDF with one line of Helvetica text per page (no parentheses or backslashes in the text)."""
    objs: list = ["<</Type/Catalog/Pages 2 0 R>>", None]
    kids = []
    for t in pages:
        pid, cid = len(objs) + 1, len(objs) + 2
        kids.append(f"{pid} 0 R")
        s = f"BT /F1 10 Tf 40 700 Td ({t}) Tj ET"
        objs.append(f"<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents {cid} 0 R"
                    f"/Resources<</Font<</F1 FONT 0 R>>>>>>")
        objs.append(f"<</Length {len(s)}>>stream\n{s}\nendstream")
    objs.append("<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>")
    fid = len(objs)
    objs[1] = f"<</Type/Pages/Kids[{' '.join(kids)}]/Count {len(pages)}>>"
    out = io.BytesIO()
    out.write(b"%PDF-1.4\n")
    offs = []
    for i, o in enumerate(objs, 1):
        offs.append(out.tell())
        out.write(f"{i} 0 obj\n{o.replace('FONT', str(fid))}\nendobj\n".encode())
    x = out.tell()
    out.write(f"xref\n0 {len(objs) + 1}\n0000000000 65535 f \n".encode())
    for o in offs:
        out.write(f"{o:010d} 00000 n \n".encode())
    out.write(f"trailer<</Size {len(objs) + 1}/Root 1 0 R>>\nstartxref\n{x}\n%%EOF\n".encode())
    return out.getvalue()
