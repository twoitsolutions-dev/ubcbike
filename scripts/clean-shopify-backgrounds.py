#!/usr/bin/env python3
"""
UBC Shopify Product Background Cleaner
--------------------------------------
Scans Shopify product lead images to detect non-white / non-transparent backgrounds
(gray studio backdrops, colored walls, outdoor photos), removes the background with
local AI (rembg), centers the cutout onto a clean transparent PNG (or pure #FFFFFF),
and uploads it as the product's primary image (position 0) while preserving the
original photo in the gallery.

Usage examples:
  # 1. Preview which Black Friday products need background cleanup (no changes):
  python scripts/clean-shopify-backgrounds.py --collection black-friday-deals --dry-run

  # 2. Clean and upload transparent PNGs for Black Friday products:
  python scripts/clean-shopify-backgrounds.py --collection black-friday-deals --apply

  # 3. Clean a single product by handle:
  python scripts/clean-shopify-backgrounds.py --handle turbo-levo-comp-carbon --apply

  # 4. Scan all active in-stock UBC Tampa products:
  python scripts/clean-shopify-backgrounds.py --query "status:active AND tag:ubc-tampa-stock" --dry-run
"""

import argparse
import io
import json
import os
import sys
import time
import urllib.request
from pathlib import Path
from PIL import Image


def load_dotenv(env_path: Path):
    if not env_path.exists():
        return
    for raw in env_path.read_text(encoding="utf-8", errors="ignore").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        k = k.strip()
        v = v.strip().strip('"').strip("'")
        if k and k not in os.environ:
            os.environ[k] = v


def shopify_gql(domain: str, token: str, query: str, variables: dict | None = None):
    url = f"https://{domain}/admin/api/2025-01/graphql.json"
    payload = json.dumps({"query": query, "variables": variables or {}}).encode("utf-8")
    for attempt in range(5):
        req = urllib.request.Request(
            url,
            data=payload,
            headers={
                "X-Shopify-Access-Token": token,
                "Content-Type": "application/json",
            },
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        if data.get("errors"):
            if any(e.get("extensions", {}).get("code") == "THROTTLED" for e in data["errors"]):
                time.sleep(1.2 * (attempt + 1))
                continue
            raise RuntimeError(f"Shopify GraphQL error: {data['errors']}")
        return data["data"]
    raise RuntimeError("Shopify GraphQL throttled repeatedly")


def download_image(url: str) -> Image.Image:
    req = urllib.request.Request(url, headers={"User-Agent": "UBC-BG-Cleaner/1.0"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        raw = resp.read()
    return Image.open(io.BytesIO(raw)).convert("RGBA")


def inspect_background(img: Image.Image) -> tuple[bool, str]:
    """
    Inspects the 4 corners + border pixels to distinguish genuine non-white
    backgrounds (gray/dark/colored backdrops) from white-background product
    photos where a tire or handlebar merely touches one edge.
    Returns (needs_cleanup, reason_string).
    """
    w, h = img.size
    px = img.load()
    corners = [(2, 2), (w - 3, 2), (2, h - 3), (w - 3, h - 3)]
    margin_x = max(2, min(10, w // 50))
    margin_y = max(2, min(10, h // 50))
    pts = corners + [
        (w // 4, margin_y),
        (w // 2, margin_y),
        (3 * w // 4, margin_y),
        (w // 4, h - 1 - margin_y),
        (3 * w // 4, h - 1 - margin_y),
        (margin_x, h // 4),
        (margin_x, 3 * h // 4),
        (w - 1 - margin_x, h // 4),
        (w - 1 - margin_x, 3 * h // 4),
    ]

    def is_clean(rgba):
        r, g, b, a = rgba
        return a < 25 or (r >= 245 and g >= 245 and b >= 245 and a >= 240)

    dirty_corners = [px[x, y][:3] for (x, y) in corners if not is_clean(px[x, y])]
    dirty_pts = [px[x, y][:3] for (x, y) in pts if not is_clean(px[x, y])]

    # Must have at least 3 of 4 corners non-white OR >= 55% of all border points non-white
    if len(dirty_corners) < 3 and (len(dirty_pts) / len(pts)) < 0.55:
        return False, "already white/transparent"

    samples = dirty_corners or dirty_pts
    ar = sum(c[0] for c in samples) // len(samples)
    ag = sum(c[1] for c in samples) // len(samples)
    ab = sum(c[2] for c in samples) // len(samples)
    return True, f"non-white bg avg #{ar:02X}{ag:02X}{ab:02X} ({len(dirty_corners)}/4 corners, {len(dirty_pts)}/{len(pts)} border pts)"


def clean_image_bytes(img: Image.Image, rembg_remove, session, mode: str = "transparent") -> bytes:
    """Remove background, trim whitespace, center with clean padding on transparent or white canvas."""
    # Resize very huge images down to max 1600px before rembg for speed & crispness
    max_side = 1600
    if max(img.size) > max_side:
        img.thumbnail((max_side, max_side), Image.Resampling.LANCZOS)

    cutout = rembg_remove(img, session=session).convert("RGBA")

    # Trim transparent margins using alpha bounding box (threshold alpha > 12)
    alpha = cutout.getchannel("A")
    mask = alpha.point(lambda p: 255 if p > 12 else 0)
    bbox = mask.getbbox()
    if bbox:
        cutout = cutout.crop(bbox)

    cw, ch = cutout.size
    # Create clean padded canvas (6% margin on each side)
    pad_x = max(24, int(cw * 0.06))
    pad_y = max(24, int(ch * 0.06))
    out_w = cw + pad_x * 2
    out_h = ch + pad_y * 2

    if mode == "white":
        canvas = Image.new("RGBA", (out_w, out_h), (255, 255, 255, 255))
        canvas.alpha_composite(cutout, (pad_x, pad_y))
        final_img = canvas.convert("RGB")
        buf = io.BytesIO()
        final_img.save(buf, format="PNG", optimize=True)
        return buf.getvalue()
    else:
        canvas = Image.new("RGBA", (out_w, out_h), (0, 0, 0, 0))
        canvas.alpha_composite(cutout, (pad_x, pad_y))
        buf = io.BytesIO()
        canvas.save(buf, format="PNG", optimize=True)
        return buf.getvalue()


def upload_and_promote_media(domain: str, token: str, product_id: str, handle: str, png_bytes: bytes, alt_text: str):
    filename = f"ubc-clean-bg-{handle[:45]}.png"

    # 1. Request staged upload target
    staged = shopify_gql(
        domain,
        token,
        """
        mutation($input: [StagedUploadInput!]!) {
          stagedUploadsCreate(input: $input) {
            stagedTargets {
              url
              resourceUrl
              parameters { name value }
            }
            userErrors { field message }
          }
        }
        """,
        {
            "input": [
                {
                    "resource": "IMAGE",
                    "filename": filename,
                    "mimeType": "image/png",
                    "fileSize": str(len(png_bytes)),
                    "httpMethod": "POST",
                }
            ]
        },
    )
    errs = staged["stagedUploadsCreate"]["userErrors"]
    if errs:
        raise RuntimeError(f"stagedUploadsCreate error: {errs}")
    target = staged["stagedUploadsCreate"]["stagedTargets"][0]

    # 2. Multipart POST to staged target
    boundary = "----UBCBgCleanerBoundary7MA4YWxkTrZu0gW"
    parts = []
    for p in target["parameters"]:
        parts.append(
            f'--{boundary}\r\nContent-Disposition: form-data; name="{p["name"]}"\r\n\r\n{p["value"]}\r\n'.encode("utf-8")
        )
    parts.append(
        f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{filename}"\r\nContent-Type: image/png\r\n\r\n'.encode("utf-8")
    )
    parts.append(png_bytes)
    parts.append(f"\r\n--{boundary}--\r\n".encode("utf-8"))
    body = b"".join(parts)

    req = urllib.request.Request(
        target["url"],
        data=body,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        if resp.status not in (200, 201, 204):
            raise RuntimeError(f"Staged upload HTTP {resp.status}")

    # 3. Attach media to product
    created = shopify_gql(
        domain,
        token,
        """
        mutation($productId: ID!, $media: [CreateMediaInput!]!) {
          productCreateMedia(productId: $productId, media: $media) {
            media { id status }
            mediaUserErrors { field message }
          }
        }
        """,
        {
            "productId": product_id,
            "media": [
                {
                    "originalSource": target["resourceUrl"],
                    "mediaContentType": "IMAGE",
                    "alt": alt_text,
                }
            ],
        },
    )
    m_errs = created["productCreateMedia"]["mediaUserErrors"]
    if m_errs:
        raise RuntimeError(f"productCreateMedia error: {m_errs}")
    new_media_id = created["productCreateMedia"]["media"][0]["id"]

    # 4. Promote new clean PNG to position 0 (lead image)
    time.sleep(0.6)
    reordered = shopify_gql(
        domain,
        token,
        """
        mutation($id: ID!, $moves: [MoveInput!]!) {
          productReorderMedia(id: $id, moves: $moves) {
            mediaUserErrors { field message }
          }
        }
        """,
        {"id": product_id, "moves": [{"id": new_media_id, "newPosition": "0"}]},
    )
    r_errs = reordered["productReorderMedia"]["mediaUserErrors"]
    if r_errs:
        raise RuntimeError(f"productReorderMedia error: {r_errs}")
    return new_media_id


def fetch_products(domain: str, token: str, args) -> list[dict]:
    products = []
    if args.handle:
        d = shopify_gql(
            domain,
            token,
            """
            query($h: String!) {
              productByHandle(handle: $h) {
                id handle title featuredImage { url }
              }
            }
            """,
            {"h": args.handle},
        )
        if d.get("productByHandle"):
            products.append(d["productByHandle"])
        return products

    if args.collection:
        cursor = None
        while True:
            d = shopify_gql(
                domain,
                token,
                """
                query($h: String!, $c: String) {
                  collectionByHandle(handle: $h) {
                    products(first: 100, after: $c) {
                      pageInfo { hasNextPage endCursor }
                      nodes { id handle title featuredImage { url } }
                    }
                  }
                }
                """,
                {"h": args.collection, "c": cursor},
            )
            col = d.get("collectionByHandle")
            if not col:
                raise RuntimeError(f"Collection not found: {args.collection}")
            products.extend(col["products"]["nodes"])
            if not col["products"]["pageInfo"]["hasNextPage"] or (args.limit and len(products) >= args.limit):
                break
            cursor = col["products"]["pageInfo"]["endCursor"]
    else:
        q = args.query or "status:active AND tag:ubc-tampa-stock"
        cursor = None
        while True:
            d = shopify_gql(
                domain,
                token,
                """
                query($q: String!, $c: String) {
                  products(first: 100, after: $c, query: $q) {
                    pageInfo { hasNextPage endCursor }
                    nodes { id handle title featuredImage { url } }
                  }
                }
                """,
                {"q": q, "c": cursor},
            )
            products.extend(d["products"]["nodes"])
            if not d["products"]["pageInfo"]["hasNextPage"] or (args.limit and len(products) >= args.limit):
                break
            cursor = d["products"]["pageInfo"]["endCursor"]

    return products[: args.limit] if args.limit else products


def main():
    parser = argparse.ArgumentParser(description="Clean non-white Shopify product backgrounds using local AI (rembg).")
    parser.add_argument("--collection", help="Shopify collection handle (e.g. black-friday-deals)")
    parser.add_argument("--handle", help="Single Shopify product handle")
    parser.add_argument("--query", help='Shopify product query (e.g. "status:active AND tag:ubc-tampa-stock")')
    parser.add_argument("--limit", type=int, default=0, help="Max products to scan (0 = all)")
    parser.add_argument("--mode", choices=["transparent", "white"], default="transparent", help="Output background mode")
    parser.add_argument("--apply", action="store_true", help="Actually clean and upload to Shopify (default is dry-run)")
    parser.add_argument("--dry-run", action="store_true", help="Scan only without modifying Shopify (default)")
    args = parser.parse_args()

    repo_root = Path(__file__).resolve().parent.parent
    load_dotenv(repo_root / ".env")
    domain = os.environ.get("UBC_LIVE_SHOPIFY_DOMAIN")
    token = os.environ.get("UBC_LIVE_SHOPIFY_ACCESS_TOKEN")
    if not domain or not token:
        print("ERROR: Missing UBC_LIVE_SHOPIFY_DOMAIN or UBC_LIVE_SHOPIFY_ACCESS_TOKEN in .env", file=sys.stderr)
        sys.exit(1)

    products = fetch_products(domain, token, args)
    print(f"Scanning {len(products)} products...")

    to_clean = []
    skipped_clean = 0
    skipped_no_img = 0

    for p in products:
        img_url = (p.get("featuredImage") or {}).get("url")
        if not img_url:
            skipped_no_img += 1
            continue
        if "ubc-clean-bg-" in img_url:
            skipped_clean += 1
            continue
        try:
            img = download_image(img_url)
            needs, reason = inspect_background(img)
            if needs:
                to_clean.append((p, img, reason))
                print(f"  [NEEDS CLEAN] {p['handle']} | {p['title']} -> {reason}")
            else:
                skipped_clean += 1
        except Exception as exc:
            print(f"  [WARN] {p['handle']}: {exc}")

    print(
        f"\nSummary: {len(to_clean)} need background cleanup | {skipped_clean} already white/transparent | {skipped_no_img} no image"
    )

    if not args.apply or not to_clean:
        if to_clean and not args.apply:
            print("\nRun again with --apply to remove backgrounds and upload clean PNGs to Shopify.")
        return

    print(f"\nLoading rembg AI model (mode={args.mode})...")
    from rembg import new_session, remove as rembg_remove

    session = new_session("u2net")
    cleaned = 0
    for idx, (p, img, reason) in enumerate(to_clean, 1):
        try:
            t0 = time.time()
            png_bytes = clean_image_bytes(img, rembg_remove, session, mode=args.mode)
            media_id = upload_and_promote_media(domain, token, p["id"], p["handle"], png_bytes, p["title"])
            cleaned += 1
            print(
                f"  [{idx}/{len(to_clean)}] CLEANED & PROMOTED {p['handle']} ({len(png_bytes)//1024} KB, {time.time()-t0:.1f}s) -> {media_id}"
            )
        except Exception as exc:
            print(f"  [ERR] {p['handle']}: {exc}")

    print(f"\nDone! Cleaned and promoted {cleaned}/{len(to_clean)} products in Shopify.")


if __name__ == "__main__":
    main()
