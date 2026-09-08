#!/usr/bin/env python3
"""Collect public wedding-pose reference images into images/delete.

The collector uses public image-search result pages to discover original images,
then stores only sufficiently large, valid, non-duplicate photographs.  Source
URLs and discovery channels are written to images/catalog.json.
"""

from __future__ import annotations

import argparse
import hashlib
import html
import io
import json
import random
import re
import time
from pathlib import Path
from urllib.parse import quote_plus, urlparse

import requests
from PIL import Image, ImageFilter, ImageOps, ImageStat


ROOT = Path(__file__).resolve().parents[1]
IMAGES = ROOT / "images"
DELETE = IMAGES / "delete"
CATALOG = IMAGES / "catalog.json"
SUPPORTED = {".jpg", ".jpeg", ".png", ".webp", ".avif"}
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36"
SESSION = requests.Session()
SESSION.headers.update({"User-Agent": UA, "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.7"})

STUDIOS = [
    "원규 스튜디오", "가을 스튜디오", "보다 스튜디오", "섬 스튜디오",
    "아테소 스튜디오", "리저브 스튜디오", "비슈어 스튜디오", "아우라 스튜디오",
    "루미에르레브", "온뜰에피움", "메리드 스튜디오", "플리트비체 스튜디오",
    "달빛스쿠터", "봉 스튜디오", "비포원 스튜디오", "소공원 스튜디오",
]

CATEGORY_PLAN = {
    "male": (60, ["신랑 단독 전신 포즈", "남자 솔로 웨딩 화보", "신랑 독사진 호리존"]),
    "female": (80, ["신부 단독 전신 포즈", "여자 솔로 웨딩 화보", "신부 독사진 호리존"]),
    "couple": (110, ["신랑 신부 커플 포즈", "웨딩 화보 커플 전신", "커플 웨딩 촬영 호리존"]),
    "outdoor": (50, ["야외 셀프웨딩 전신 포즈", "공원 셀프웨딩 커플", "제주 셀프웨딩 포즈"]),
}

SOURCE_FILTERS = [
    ("네이버 블로그", "site:blog.naver.com"),
    ("다음", "site:blog.daum.net OR site:cafe.daum.net"),
    ("핀터레스트", "site:pinterest.com OR site:pinterest.co.kr"),
    ("공식/웹", ""),
]


def bing_images(query: str, pages: int = 4):
    for page in range(pages):
        url = f"https://www.bing.com/images/search?q={quote_plus(query)}&first={page * 35 + 1}&count=35"
        try:
            text = SESSION.get(url, timeout=20).text
        except requests.RequestException:
            continue
        for raw in re.findall(r"\bm=\"([^\"]+)\"", text):
            try:
                data = json.loads(html.unescape(raw))
            except Exception:
                continue
            image_url = data.get("murl")
            page_url = data.get("purl") or data.get("surl") or ""
            if image_url:
                yield image_url, page_url


def google_images(query: str):
    url = f"https://www.google.com/search?tbm=isch&hl=ko&q={quote_plus(query)}"
    try:
        text = SESSION.get(url, timeout=20).text
    except requests.RequestException:
        return
    # Google result markup changes often; these two forms cover current public HTML.
    patterns = [
        r'\["(https?://[^"\\]+?\.(?:jpe?g|png|webp)(?:\?[^"\\]*)?)",\d+,\d+\]',
        r'"ou":"(https?://[^"\\]+)"',
    ]
    seen = set()
    for pattern in patterns:
        for raw in re.findall(pattern, text, flags=re.I):
            image_url = html.unescape(raw).replace("\\u003d", "=").replace("\\u0026", "&")
            if image_url in seen or "googleusercontent.com" in image_url or "gstatic.com" in image_url:
                continue
            seen.add(image_url)
            yield image_url, url


def dhash(image: Image.Image) -> int:
    gray = ImageOps.grayscale(image).resize((9, 8), Image.Resampling.LANCZOS)
    pixels = list(gray.getdata())
    value = 0
    for y in range(8):
        for x in range(8):
            value = (value << 1) | (pixels[y * 9 + x] > pixels[y * 9 + x + 1])
    return value


def hamming(a: int, b: int) -> int:
    return (a ^ b).bit_count()


def looks_like_photo(image: Image.Image) -> bool:
    width, height = image.size
    if min(width, height) < 650 or width * height < 650_000:
        return False
    ratio = width / height
    if ratio < 0.48 or ratio > 2.05:
        return False
    thumb = image.convert("RGB").resize((160, 160), Image.Resampling.LANCZOS)
    stat = ImageStat.Stat(thumb)
    if sum(stat.var) < 500:
        return False
    # Reject many flat posters/screenshots while retaining bright horizon photos.
    edge = ImageOps.grayscale(thumb).filter(ImageFilter.FIND_EDGES)
    edge_mean = ImageStat.Stat(edge).mean[0]
    colors = thumb.quantize(colors=64).getcolors() or []
    dominant = max((count for count, _ in colors), default=0) / (160 * 160)
    if dominant > 0.72 or (dominant > 0.45 and edge_mean > 32):
        return False
    return True


def existing_hashes():
    exact, perceptual = set(), []
    for path in IMAGES.rglob("*"):
        if not path.is_file() or path.suffix.lower() not in SUPPORTED:
            continue
        try:
            raw = path.read_bytes()
            exact.add(hashlib.sha256(raw).hexdigest())
            with Image.open(io.BytesIO(raw)) as image:
                perceptual.append(dhash(image.convert("RGB")))
        except Exception:
            pass
    return exact, perceptual


def download_image(url: str):
    try:
        response = SESSION.get(url, timeout=20, stream=True, headers={"Referer": "https://www.google.com/"})
        response.raise_for_status()
        content_type = response.headers.get("content-type", "").lower()
        if "image" not in content_type:
            return None
        data = response.raw.read(16_000_001, decode_content=True)
        if len(data) < 35_000 or len(data) > 16_000_000:
            return None
        with Image.open(io.BytesIO(data)) as source:
            source.load()
            image = ImageOps.exif_transpose(source).convert("RGB")
        if not looks_like_photo(image):
            return None
        return image, data
    except Exception:
        return None


def safe_slug(value: str) -> str:
    host = urlparse(value).netloc.lower().replace("www.", "")
    host = re.sub(r"[^a-z0-9]+", "-", host).strip("-")
    return host[:24] or "web"


def build_tasks():
    tasks = []
    for category, (target, phrases) in CATEGORY_PLAN.items():
        candidates = []
        if category == "outdoor":
            studios = ["한국", "서울", "제주", "부산", "경주", "인천"]
        else:
            studios = STUDIOS
        for studio in studios:
            for phrase in phrases:
                for source_label, source_filter in SOURCE_FILTERS:
                    query = " ".join(x for x in [source_filter, studio, phrase, "사진"] if x)
                    candidates.append((query, source_label, studio))
        random.Random(20260908 + len(category)).shuffle(candidates)
        tasks.append((category, target, candidates))
    return tasks


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--total", type=int, default=300)
    args = parser.parse_args()
    planned = sum(target for target, _ in CATEGORY_PLAN.values())
    if args.total != planned:
        raise SystemExit(f"This curated plan currently expects --total {planned}.")

    DELETE.mkdir(parents=True, exist_ok=True)
    try:
        catalog = json.loads(CATALOG.read_text(encoding="utf-8"))
    except Exception:
        catalog = {}
    exact_hashes, perceptual_hashes = existing_hashes()
    added = 0
    category_counts = {key: 0 for key in CATEGORY_PLAN}
    tried_urls = set()

    for category, target, tasks in build_tasks():
        print(f"[{category}] target={target}", flush=True)
        task_index = 0
        while category_counts[category] < target and task_index < len(tasks):
            query, source_label, studio = tasks[task_index]
            task_index += 1
            streams = [bing_images(query, pages=2)]
            if source_label == "공식/웹" and task_index % 4 == 0:
                streams.append(google_images(query))
            for stream in streams:
                for image_url, page_url in stream:
                    if category_counts[category] >= target:
                        break
                    if image_url in tried_urls:
                        continue
                    tried_urls.add(image_url)
                    result = download_image(image_url)
                    if not result:
                        continue
                    image, original_data = result
                    exact = hashlib.sha256(original_data).hexdigest()
                    fingerprint = dhash(image)
                    if exact in exact_hashes or any(hamming(fingerprint, old) <= 5 for old in perceptual_hashes):
                        continue

                    short_hash = hashlib.sha256(image_url.encode("utf-8")).hexdigest()[:12]
                    host = safe_slug(page_url or image_url)
                    filename = f"candidate--{category}--{host}--{short_hash}.jpg"
                    destination = DELETE / filename
                    if destination.exists():
                        continue
                    image.save(destination, "JPEG", quality=91, optimize=True, progressive=True)
                    exact_hashes.add(exact)
                    perceptual_hashes.append(fingerprint)
                    web_path = f"images/delete/{filename}"
                    catalog[web_path] = {
                        "width": image.width,
                        "height": image.height,
                        "account": source_label,
                        "studio": f"{studio} · {category}",
                        "source": page_url or image_url,
                        "imageSource": image_url,
                        "categoryHint": category,
                    }
                    category_counts[category] += 1
                    added += 1
                    if added % 10 == 0:
                        CATALOG.write_text(json.dumps(catalog, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
                        print(f"added={added} counts={category_counts}", flush=True)
            time.sleep(0.15)

    CATALOG.write_text(json.dumps(catalog, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"added": added, "counts": category_counts}, ensure_ascii=False), flush=True)
    if added != args.total:
        raise SystemExit(f"Only collected {added}/{args.total}; rerun after expanding queries.")


if __name__ == "__main__":
    main()
