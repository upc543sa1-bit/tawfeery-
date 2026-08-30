from flask import Flask, render_template, request, Response, stream_with_context
import requests
import cloudscraper
from bs4 import BeautifulSoup
import urllib.parse
import concurrent.futures
import json
import re
import math

app = Flask(__name__)
APP_VERSION = '1.5.7'
# CORS for split HF Static frontend -> Render backend
@app.after_request
def _cors(resp):
    resp.headers['Access-Control-Allow-Origin'] = '*'
    resp.headers['Access-Control-Allow-Headers'] = 'Content-Type'
    resp.headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS'
    return resp

import threading as _threading
_moaz_lock = _threading.Lock()
_moaz_last_call = 0
_search_cache = {}
_search_cache_lock = _threading.Lock()
CACHE_TTL = 600  # 10 min

# ── Smart Image-Hash Engine (image-first comparison) ─────────────────────────

_image_hash_cache = {}
_image_hash_lock = _threading.Lock()

def compute_image_hash(url):
    """Perceptual average hash (aHash) 8x8 → 16 hex chars. Cached. Returns None on failure."""
    if not url or not url.startswith('http'):
        return None
    with _image_hash_lock:
        if url in _image_hash_cache:
            return _image_hash_cache[url]
    try:
        from PIL import Image
        import io
        resp = requests.get(url, timeout=3, headers={'User-Agent': 'Mozilla/5.0 Chrome/120'}, stream=True)
        if resp.status_code != 200:
            return None
        # Limit download size to 800KB to avoid huge files
        content = resp.content[:800_000]
        img = Image.open(io.BytesIO(content))
        # Handle transparency / palette
        if img.mode in ('RGBA', 'LA', 'P'):
            bg = Image.new('RGB', img.size, (255, 255, 255))
            if img.mode == 'P':
                img = img.convert('RGBA')
            bg.paste(img, mask=img.split()[-1] if img.mode in ('RGBA','LA') else None)
            img = bg
        else:
            img = img.convert('RGB')
        img = img.convert('L').resize((8, 8), Image.LANCZOS)
        pixels = list(img.getdata())
        avg = sum(pixels) / len(pixels)
        bits = ''.join('1' if p > avg else '0' for p in pixels)
        hex_str = hex(int(bits, 2))[2:].zfill(16)
        with _image_hash_lock:
            _image_hash_cache[url] = hex_str
            # Keep cache bounded (2000 entries)
            if len(_image_hash_cache) > 2000:
                # evict oldest 500
                for k in list(_image_hash_cache.keys())[:500]:
                    _image_hash_cache.pop(k, None)
        return hex_str
    except Exception:
        return None

def bulk_image_hash(items, max_workers=3):
    """Compute image_hash for each item in parallel (adds 'image_hash' field). Fast, best-effort. Limited to 10 to keep search snappy."""
    if not items:
        return items
    # Only hash items with image url; limit to first 10 to keep search fast
    # Full hashing for deals (up to 50) still ok but limited workers keep it fast
    to_hash = [it for it in items if it.get('image')][:10]
    if not to_hash:
        return items
    def _hash_one(item):
        h = compute_image_hash(item.get('image'))
        if h:
            item['image_hash'] = h
        return item
    # Limit threads to avoid overload; timeout per hash is 2s, overall 4s
    try:
        with concurrent.futures.ThreadPoolExecutor(max_workers=max_workers) as ex:
            # Use map with timeout per item
            futures = {ex.submit(_hash_one, it): it for it in to_hash}
            for fut in concurrent.futures.as_completed(futures, timeout=4):
                try:
                    fut.result(timeout=1)
                except:
                    pass
    except Exception:
        pass
    return items

def hamming_distance(h1, h2):
    if not h1 or not h2 or len(h1) != 16 or len(h2) != 16:
        return 999
    try:
        return bin(int(h1, 16) ^ int(h2, 16)).count('1')
    except:
        return 999

def apply_image_hashes_async(items):
    """Apply cached hashes instantly; hash uncached in background so search stays fast."""
    if not items:
        return items
    # Instant cached
    for it in items:
        h = _image_hash_cache.get(it.get('image'))
        if h:
            it['image_hash'] = h
    # Background for uncached (limit 10)
    to_hash = [it for it in items if it.get('image') and 'image_hash' not in it][:10]
    if to_hash:
        import threading
        threading.Thread(target=bulk_image_hash, args=(to_hash,), daemon=True).start()
    return items


# ── AI Embeddings (fastembed + BGE) ───────────────────────────────────────────
# DISABLED by default. BGE-small (~300MB RAM) OOMs Render free tier (512MB),
# causing 502s. Enable only on hosts with enough RAM: set env TAWFEERY_AI=1.
# Matching still works without AI (token/line/image signals used in frontend).

import os as _os
_AI_ENABLED = _os.environ.get('TAWFEERY_AI', '0') == '1'

_embed_model = None
_embedding_cache = {}

def _get_embed_model():
    global _embed_model
    if _embed_model is None:
        if not _AI_ENABLED:
            print("[AI] Disabled (set TAWFEERY_AI=1 to enable BGE embeddings)")
            return None
        try:
            from fastembed import TextEmbedding
            _embed_model = TextEmbedding("BAAI/bge-small-en-v1.5")
            print("[AI] Embedding model loaded (BGE-small-en, 384d)")
        except Exception as e:
            print(f"[AI] Embedding model failed to load: {e}")
    return _embed_model

def compute_embeddings(texts):
    """Compute 384-dim embeddings for a list of texts. Returns list of lists."""
    model = _get_embed_model()
    if not model:
        return [None] * len(texts)
    results = []
    for t in texts:
        if t in _embedding_cache:
            results.append(_embedding_cache[t])
        else:
            try:
                vec = list(model.embed([t]))[0].tolist()
                _embedding_cache[t] = vec
                results.append(vec)
            except Exception:
                results.append(None)
    return results


# ── Structured Name Parser ────────────────────────────────────────────────────

PRODUCT_LINES = {
    'bioderma': [
        'sebium', 'سيبيوم',
        'sensibio', 'سينسيبيو', 'سنسبيو',
        'cicabio', 'سكينبيو', 'سكيببيو',
        'atoderm', 'اتوديرم', 'اتادرم',
        'abcrème', 'اب كريم',
        'hydrabio', 'هيدرابيو',
        'nodé', 'نود',
        'photoderm', 'فوتوديرم',
        'whitening', 'ويتنينج',
    ],
    'panadol': ['advance', 'extra', 'night', 'nano', 'baby', 'نايت', 'ناโน'],
    'nurofen': ['plus', 'express', 'forte', 'برو', 'فورته'],
    'voltaren': ['emulgel', 'SR'],
    'augmentin': ['duo', 'ES'],
    'amoxil': ['clavulanate'],
    'maxon': [
        'hydramax', 'هيدراماكس', 'هيدرامكس',
        'soft white', 'سوفت وايت',
        'deo active', 'ديو اكتيف',
        'mammy', 'مامي',
    ],
    'carsia': ['كارسيا'],
}

SUBTYPE_KEYWORDS = [
    'cream', 'كريم', 'gel', 'جل', 'lotion', 'لوشن', 'serum', 'سيروم',
    'shampoo', 'شامبو', 'soap', 'صابون', 'capsule', 'كبسولة', 'tablet', 'قرص',
    'syrup', 'شراب', 'drops', 'قطرات', 'spray', 'رذاذ', 'powder', 'بودرة',
    'solution', 'محاليل', 'wipes', 'مسحوق', 'ointment', 'مرهم',
    'foam', 'رغوة', 'mousse', 'mask', 'ماسك', 'cleanser', 'منظف',
    'moisturizer', 'مرطب', 'moist', 'مرطب', ' hydr ', 'هيدرا',
]

def parse_product_name(name):
    if not name:
        return {'brand': '', 'line': '', 'subtype': '', 'size': ''}
    low = name.lower().strip()
    brand = ''
    for b in ['bioderma', 'بيوديرما', 'panadol', 'بنادول', 'nurofen', 'نوروفين',
              'voltaren', 'فولتارين', 'augmentin', 'اوجمنتين', 'amoxil', 'اموكسيل',
              'claritine', 'كلاريتين', 'tylenol', 'تايلينول', 'advil', 'ادفيل',
              'calpol', 'كالبول', 'allegra', 'الлегرا']:
        if b in low:
            brand = b
            break
    line = ''
    if brand in PRODUCT_LINES:
        for ln in PRODUCT_LINES[brand]:
            if ln.lower() in low:
                line = ln.lower()
                break
    if not line:
        for b, lines in PRODUCT_LINES.items():
            for ln in lines:
                if ln.lower() in low:
                    line = ln.lower()
                    break
            if line:
                break
    subtype = ''
    for kw in SUBTYPE_KEYWORDS:
        if kw.lower() in low:
            subtype = kw.lower()
            break
    size = ''
    size_patterns = [
        r'(\d+(?:\.\d+)?)\s*(?:مل|ملي|ml|mL|ML)',
        r'(\d+(?:\.\d+)?)\s*(?:جم|جرام|غرام|gm?)',
        r'(\d+(?:\.\d+)?)\s*(?:لتر|liter)',
        r'(\d+(?:\.\d+)?)\s*(?:حبة|حبات|قرص|كبسولة|tablets?|capsules?|pcs)',
    ]
    for pat in size_patterns:
        m = re.search(pat, low)
        if m:
            size = m.group(0).strip()
            break
    return {'brand': brand, 'line': line, 'subtype': subtype, 'size': size}


BRAND_SYNONYMS = {
    'maxon': ['ماكسون', 'maxon'],
    'bioderma': ['بيوديرما', 'bioderma'],
    'panadol': ['بنادول', 'بانادول', 'panadol'],
    'nurofen': ['نوروفين', 'nurofen'],
    'voltaren': ['فولتارين', 'voltaren'],
    'sebium': ['سيبيوم', 'sebium'],
    'sensibio': ['سينسيبيو', 'sensibio'],
}

def is_relevant(name, query):
    if not name or not query:
        return False
    nl = name.lower().replace('ـ', '')
    ql = query.lower().replace('ـ', '').strip()
    # direct substring
    if ql in nl:
        return True
    qtokens = [t for t in ql.split() if len(t) >= 2]
    if not qtokens:
        return True
    for tok in qtokens:
        if tok in nl:
            return True
        # brand synonym cross-language
        for key, syns in BRAND_SYNONYMS.items():
            if tok == key or tok in syns:
                for s in syns:
                    if s in nl:
                        return True
        # also check cleaned tokens overlap
        for word in nl.split():
            if tok in word or word in tok:
                if len(tok) >= 4:
                    return True
    return False

def apply_ai_fields(items):
    """Add embedding vectors + structured parsed fields to each item."""
    if not items:
        return items
    for it in items:
        parsed = parse_product_name(it.get('name', ''))
        it['product_line'] = parsed['line']
        it['product_brand'] = parsed['brand']
        it['product_subtype'] = parsed['subtype']
        it['product_size'] = parsed['size']
    names = [it.get('name', '') for it in items]
    embeddings = compute_embeddings(names)
    for it, emb in zip(items, embeddings):
        if emb:
            it['embedding'] = emb
    return items


# ── Quantity Extraction & Unit Price Normalization ───────────────────────────

def extract_quantity(name):
    """Extract item count from a product name (e.g. 'عدد 30', '30 حبة', '30 Tablets')."""
    if not name:
        return None
    text = name.replace('ـ', '').replace(',', '').strip()

    # Patterns: عدد 30, quantity 30, 30's, 30+1
    patterns = [
        # Arabic: عدد 30
        r'عدد\s*(\d+)',
        # Arabic: 30 حبة, 30 حبّة, 30 قرص, 30 كبسولة, 30 كبسولة, 30 حفاض, 30 حفاضة, 30 قطعة, 100 مل, 200 جم
        r'(\d+)\s*(حبة|حبّة|حبات|قرص|اقراص|كبسولة|كبسولات|حفاض|حفاضة|حفائض|قطعة|قطعه|قطع|شريط|شرائط|ملعقة|ملىء|حقنة|امبول|امبولات|لبوس|تحميلة|مل|ملي|جم|جرام|غرام|لتر|مليلتر|كجم|كغ|غ)',
        # English: 30 Tablets, 30 Capsules, 30 Pills, 30 Diapers, 30 Pieces, 30's, 200ML, 100G
        r'(\d+)\s*(Tablets?|Capsules?|Pills?|Diapers?|Pieces?|Count|Pack|Tabs?|Caps?|Pcs|ML|Mg|G|KG|Ml|L|Gr|Gram)',
        # Pack of 30
        r'(?:Pack|pack|عبوة|علبة)\s*(?:of|OF|)\s*(\d+)',
        # 30+1, 30+1 Free
        r'(\d+)\s*\+\s*\d+',
        # 30x, 30 X (but NOT مقاس 3 / Size 3)
        r'(\d+)\s*[xX×](?!\s*مقاس|\s*Size)',
        # 30's, 30ct
        r'(\d+)[\'\u2019]?[sS]\b',
        r'(\d+)\s*[cC][tT]\b',
    ]

    # Skip if it's a size pattern (مقاس 3, Size 3, مقاس كبير, etc.)
    if re.search(r'(مقاس|size|large|medium|small|كبير|وسط|صغير)', text, re.I):
        # Still try to extract if there's a clear count AND size mention
        pass

    for pat in patterns:
        m = re.search(pat, text, re.I)
        if m:
            val = int(m.group(1))
            if 0 < val <= 500:  # Sanity check
                return val
    return None


def compute_unit_price(price, quantity):
    """Return unit price (price per item) if quantity is valid, else None."""
    if quantity and quantity > 0:
        return round(price / quantity, 4)
    return None


def enrich_item(item, raw_hit=None):
    """Add quantity and unit_price fields to a scraper result.
    If raw_hit is provided, check for additional price/promo fields."""
    # Quantity: try raw hit's quantity field first (e.g. Nahdi's "24 حبة")
    qty = item.get('quantity')
    if not qty and raw_hit:
        raw_qty = raw_hit.get('quantity') if isinstance(raw_hit, dict) else None
        if raw_qty:
            # "24 حبة" -> 24  or  "30 حفاض" -> 30
            import re as _re
            m = _re.search(r'(\d+)', str(raw_qty))
            if m:
                qty = int(m.group(1))
    if not qty:
        qty = extract_quantity(item.get('name', ''))
    item['quantity'] = qty

    # Unit price
    if 'unit_price' not in item or not item['unit_price']:
        item['unit_price'] = compute_unit_price(item['price'], item['quantity'])

    # Check for special/offer price from raw hit (only if scraper found NO offer)
    # Skip if scraper marked price as already discounted (prevents double-discount)
    if raw_hit and isinstance(raw_hit, dict) and not item.get('offer') and not item.get('_price_is_discounted'):
        # Discount percentage (e.g. خصم 21% or string "-20%")
        discount_raw = raw_hit.get('discount', 0)
        try:
            if isinstance(discount_raw, str):
                # extract number from string like "-20%" or "20%"
                m = re.search(r'(\d+)', str(discount_raw))
                discount_pct = int(m.group(1)) if m else 0
                # ignore -0% placeholder
                if discount_pct and discount_pct < 100 and discount_pct > 0:
                    item['offer'] = f"خصم {discount_pct}%"
            elif isinstance(discount_raw, (int, float)) and discount_raw and discount_raw < 100 and discount_raw > 0:
                item['offer'] = f"خصم {discount_raw}%"
        except:
            pass
        if not item.get('offer') and raw_hit.get('clearance_offer') == 'Yes':
            item['offer'] = 'تخفيضات التصفية'

    return item


# ── United Pharmacy via Algolia JSON API ──────────────────────────────────────

def scrape_united(query):
    results = []
    try:
        headers = {
            'X-Algolia-API-Key': 'NGFkYzM5MDgzYjA0YmI2YzdlYjk4YjIwNDFjZjQzZTg2ZDQ4M2Q0ZGM5ZTVjYTgxYTNjZWRlMjllZDg0YTg3Y3RhZ0ZpbHRlcnM9',
            'X-Algolia-Application-Id': 'Y1GOQ9DTV8'
        }
        url = 'https://Y1GOQ9DTV8-dsn.algolia.net/1/indexes/*/queries'
        payload = {
            "requests": [{
                "indexName": "unitedpharmacy_livear_products",
                "params": f"query={urllib.parse.quote(query)}&hitsPerPage=50"
            }]
        }
        res = requests.post(url, headers=headers, json=payload, timeout=10)
        if res.status_code == 200:
            hits = res.json().get('results', [{}])[0].get('hits', [])
            for h in hits:
                name = h.get('name', '')
                price_val = h.get('price', 0)
                if isinstance(price_val, dict):
                    price_val = price_val.get('SAR', {}).get('default', 0)
                elif isinstance(price_val, list):
                    price_val = price_val[0] if price_val else 0
                img_url = h.get('image_url') or h.get('thumbnail_url', '')
                link = h.get('url', '')
                if price_val and name:
                    try:
                        offer_text = ''
                        price_already_discounted = False
                        # Detect if SAR.default is already discounted by checking original price
                        sar_info = h.get('price', {}).get('SAR', {}) if isinstance(h.get('price'), dict) else {}
                        orig_price = sar_info.get('bv_default_original') or sar_info.get('default_original')
                        if orig_price:
                            try:
                                if float(orig_price) > float(price_val):
                                    price_already_discounted = True
                            except:
                                pass
                        if h.get('isOfferApplicable'):
                            if price_already_discounted and orig_price:
                                offer_text = f"عرض خاص (بدلاً من {float(orig_price):.2f} SAR)"
                            else:
                                offer_text = h.get('offerApplicableLabel', '')
                        elif price_already_discounted and orig_price:
                            # Has discount in price but no label — still show as promo info-only
                            offer_text = f"عرض خاص (بدلاً من {float(orig_price):.2f} SAR)"
                        
                        item = {
                            'store': 'United Pharmacy',
                            'name': name,
                            'price': float(price_val),
                            'image': img_url,
                            'link': link,
                            'offer': offer_text,
                            '_price_is_discounted': price_already_discounted,
                        }
                        enrich_item(item, raw_hit=h)
                        results.append(item)
                    except Exception:
                        pass
    except Exception as e:
        print(f"United error: {e}")
    apply_image_hashes_async(results)
    return results


# ── Nahdi via Cloudscraper + Embedded JSON ────────────────────────────────────

def scrape_nahdi(query):
    """
    Nahdi embeds Algolia search results directly in the page HTML as:
    window[Symbol.for("InstantSearchInitialResults")] = {...}
    We extract and parse this JSON without needing a headless browser.
    """
    results = []
    try:
        scraper = cloudscraper.create_scraper()
        url = f"https://www.nahdionline.com/ar-sa/search?query={urllib.parse.quote(query)}"
        res = scraper.get(url, timeout=20)
        if res.status_code != 200:
            print(f"Nahdi HTTP error: {res.status_code}")
            return results

        soup = BeautifulSoup(res.text, 'html.parser')
        marker = 'window[Symbol.for("InstantSearchInitialResults")] = '

        for script in soup.find_all('script'):
            if not script.string or marker not in script.string:
                continue

            raw = script.string
            idx = raw.find(marker)
            if idx == -1:
                continue

            json_str = raw[idx + len(marker):]
            # Find balanced braces to extract valid JSON
            depth, end = 0, 0
            for i, c in enumerate(json_str):
                if c == '{':
                    depth += 1
                elif c == '}':
                    depth -= 1
                    if depth == 0:
                        end = i + 1
                        break
            if not end:
                continue

            data = json.loads(json_str[:end])

            # The key may vary — find whichever has hits
            for key, val in data.items():
                results_list = val.get('results', [])
                if not results_list:
                    continue
                hits = results_list[0].get('hits', [])
                for h in hits[:50]:
                    name = h.get('name', '')
                    price_val = h.get('price', 0)
                    used_special_price = False
                    if isinstance(price_val, dict):
                        sar = price_val.get('SAR', {})
                        price_val = sar.get('default', 0)
                        # Check for active special price
                        sp = sar.get('special_price')
                        if sp and sar.get('special_from_date') and sar.get('special_to_date'):
                            price_val = sp
                            used_special_price = True
                    elif not isinstance(price_val, (int, float)):
                        price_val = 0
                    img_url = h.get('image_url') or h.get('thumbnail_url', '')
                    link = h.get('url', '')
                    sku = h.get('sku', '')
                    # Nahdi product pages (/pdp/{sku}) return HTTP 500 for many products
                    # (Next.js SSR bug on their end). Search URL is 100% reliable.
                    search_q = urllib.parse.quote(name) if name else (sku or '')
                    link = f"https://www.nahdionline.com/ar-sa/search?query={search_q}"

                    if name and price_val:
                        try:
                            offer_text = ''
                            # Detect offers from multiple fields
                            if h.get('item_has_offer') == 'Yes' or h.get('isOfferApplicable') or h.get('promo_type'):
                                promo = h.get('promo_type') or h.get('offer_text') or h.get('offerApplicableLabel', '')
                                if promo:
                                    if "Buy 2  For" in promo:
                                        price = promo.replace("Buy 2  For", "").replace("SAR", "").strip()
                                        offer_text = f"اشتري 2 بسعر {price} ريال"
                                    elif "1 + 1 with 50 %" in promo:
                                        offer_text = "خصم 50% على الحبة الثانية"
                                    elif "2 + 1" in promo:
                                        offer_text = "اشتري 2 واحصل على 1 مجاناً"
                                    elif "1 + 1" in promo:
                                        offer_text = "اشتري 1 واحصل على 1 مجاناً"
                                    elif re.search(r'\d+', promo):
                                        offer_text = promo

                            # If special_price was used, price is already discounted → info-only offer
                            if used_special_price and not offer_text:
                                try:
                                    orig = h.get('price', {})
                                    if isinstance(orig, dict):
                                        orig = orig.get('SAR', {}).get('default', 0)
                                    if orig and float(orig) > float(price_val):
                                        offer_text = f"عرض خاص (بدلاً من {float(orig):.2f} SAR)"
                                except:
                                    pass

                            item = {
                                'store': 'Nahdi Online',
                                'name': name,
                                'price': float(price_val),
                                'image': img_url,
                                'link': link,
                                'offer': offer_text,
                                '_price_is_discounted': used_special_price,
                            }
                            enrich_item(item, raw_hit=h)
                            results.append(item)
                        except Exception:
                            pass
            break  # Only process the first matching script
    except Exception as e:
        print(f"Nahdi error: {e}")
    apply_image_hashes_async(results)
    return results


# ── Al-Dawaa via OCC REST API ─────────────────────────────────────────────────

def scrape_aldawaa(query):
    results = []
    try:
        url = 'https://stgprevapi.al-dawaa.com/occ/v2/aldawaa/products/search'
        params = {
            'query': query,
            'pageSize': 50,
            'lang': 'ar',
            'curr': 'SAR'
        }
        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'application/json, text/plain, */*',
            'Accept-Language': 'ar,en-US;q=0.9,en;q=0.8',
            'Connection': 'keep-alive'
        }
        res = requests.get(url, params=params, headers=headers, timeout=20)
        if res.status_code != 200:
            print(f"Al-Dawaa OCC HTTP error: {res.status_code}")
            return results

        data = res.json()
        products = data.get('products', [])

        for p in products:
            name = p.get('name', '')
            if not name:
                continue

            # ── Price: price.value is the finalPrice (after discount if on sale)
            # previousPrice.value is the oldPrice (original before discount)
            price_val = p.get('price', {}).get('value')
            if price_val is None:
                continue

            old_price = p.get('previousPrice', {}).get('value') if isinstance(p.get('previousPrice'), dict) else None
            price_is_discounted = bool(old_price and float(old_price) > float(price_val))

            # simulatedDiscountPrice is the delivery-only discounted price
            simulated = p.get('simulatedDiscountPrice', {})
            sim_val = simulated.get('value') if simulated else None
            delivery_discount_text = ''
            if sim_val and sim_val < price_val:
                saving = round(price_val - sim_val, 2)
                delivery_discount_text = f"سعر التوصيل: {sim_val:.2f} ريال (وفّر {saving:.2f} ريال)"

            # Image processing
            img_url = ''
            image_urls = p.get('imageUrl', [])
            if isinstance(image_urls, list) and len(image_urls) > 0:
                ar_img = next((img.get('value') for img in image_urls if img.get('key') == 'ar'), None)
                if ar_img:
                    img_url = ar_img
                else:
                    img_url = image_urls[0].get('value', '')

            if img_url and img_url.startswith('/'):
                img_url = 'https://stgprevapi.al-dawaa.com' + img_url

            # Product link
            link = p.get('url', '')
            if link and not link.startswith('http'):
                link = 'https://www.al-dawaa.com' + link

            try:
                # Build offer text from promotions (multiple sources)
                promo_text = ''
                potential = p.get('potentialPromotions', [])
                if isinstance(potential, list) and len(potential) > 0:
                    promo_code = potential[0].get('code', '').strip()
                    if promo_code and 'توصيل' not in promo_code:
                        promo_text = promo_code

                # Check other promotion fields
                if not promo_text:
                    desc = p.get('promotionalDescriptions') or p.get('productPromotions') or p.get('promotionDescription') or ''
                    if isinstance(desc, list):
                        desc = ' '.join(str(d) for d in desc)
                    if isinstance(desc, str) and desc.strip():
                        desc = desc.strip()[:100]
                        # Only accept as offer if it looks like a real promotion
                        if any(k in desc.lower() for k in ['%', 'خصم', 'وفر', 'ريال', 'مجان', '1+', '2+', '+1', 'اشتر', 'سعر']):
                            promo_text = desc

                # Check volume pricing / bulk buy
                volume = p.get('volumePrices', [])
                if isinstance(volume, list) and len(volume) > 0 and not promo_text:
                    vp = volume[0]
                    vp_price = vp.get('price', {}).get('value') if isinstance(vp.get('price'), dict) else vp.get('value')
                    vp_qty = vp.get('minimumQuantity', 2)
                    if vp_price and vp_price < price_val:
                        promo_text = f"سعر الكمية: اشتر {vp_qty}+ بسعر {vp_price:.2f} ريال للقطعة"

                # If price is already discounted (previousPrice exists), convert percentage promos to info-only
                if price_is_discounted and old_price and promo_text:
                    pct_match = re.search(r'(\d+)\s*%', promo_text)
                    if pct_match:
                        promo_text = f"عرض خاص (بدلاً من {float(old_price):.2f} SAR)"

                # Combine promo text + delivery discount info
                if promo_text and delivery_discount_text:
                    offer_text = f"{promo_text} | {delivery_discount_text}"
                elif promo_text:
                    offer_text = promo_text
                elif delivery_discount_text:
                    offer_text = delivery_discount_text
                else:
                    offer_text = ''

                item = {
                    'store': 'Al-Dawaa',
                    'name': name,
                    'price': float(price_val),
                    'image': img_url,
                    'link': link,
                    'offer': offer_text,
                    '_price_is_discounted': price_is_discounted,
                }
                enrich_item(item, raw_hit=p)
                results.append(item)
            except Exception:
                pass
    except Exception as e:
        print(f"Al-Dawaa error: {e}")
    apply_image_hashes_async(results)
    return results


# ── Moaz Pharma via POST API (back.moazpharma.com) ───────────────────────────

def scrape_moaz(query):
    results = []
    try:
        # Rate-limit protection: ensure at least 1s gap between Moaz calls
        global _moaz_last_call
        import time as _time
        with _moaz_lock:
            now = _time.time()
            gap = now - _moaz_last_call
            if gap < 1.0:
                _time.sleep(1.0 - gap)
            _moaz_last_call = _time.time()

        url = 'https://back.moazpharma.com/api/v2/products/search'
        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'Origin': 'https://moazpharma.com',
            'Referer': 'https://moazpharma.com/',
        }
        payload = {"name": query, "page": 1}
        res = None
        for attempt in range(3):
            res = requests.post(url, json=payload, headers=headers, timeout=15)
            if res.status_code != 429:
                break
            wait = 2 + attempt * 2  # 2s, 4s, 6s
            print(f"Moaz rate limited (429), retry {attempt+1}/3 after {wait}s for query {query[:20]}")
            _time.sleep(wait)
        if not res or res.status_code != 200:
            print(f"Moaz HTTP error: {res.status_code if res else 'no response'}")
            return results
        data = res.json()
        products = data.get('data', [])
        for p in products[:50]:
            name = p.get('name', '').strip()
            if not name:
                continue
            # price: prefer calculable_price, fallback to main_price / price_high_low
            price_val = p.get('calculable_price')
            if price_val is None:
                price_val = p.get('main_price')
            if price_val is None:
                phl = p.get('price_high_low', '')
                try:
                    price_val = float(str(phl).split('-')[0].strip())
                except:
                    price_val = 0
            try:
                price_val = float(price_val)
            except:
                continue
            if not price_val or price_val <= 0:
                continue

            # image
            img_url = p.get('thumbnail_image') or ''
            if not img_url:
                photos = p.get('photos', [])
                if isinstance(photos, list) and len(photos) > 0:
                    img_url = photos[0].get('path', '') if isinstance(photos[0], dict) else str(photos[0])

            # link - Moaz uses product ID in URL (e.g. /ar/products/21662), slug alone returns blank shell
            prod_id = p.get('id', '')
            slug = p.get('slug', '')
            if prod_id:
                link = f"https://moazpharma.com/ar/products/{prod_id}"
            elif slug:
                link = f"https://moazpharma.com/ar/products/{slug}"
            else:
                link = f"https://moazpharma.com/ar/search?q={urllib.parse.quote(query)}"

            # offer — price is calculable_price (already discounted), so offer is info-only
            offer_text = ''
            if p.get('has_discount'):
                try:
                    stroked = float(p.get('stroked_price', 0) or 0)
                    main = float(p.get('main_price', 0) or price_val)
                    if stroked > main and stroked > 0 and main > 0:
                        offer_text = f"عرض خاص (بدلاً من {stroked:.2f} SAR)"
                except:
                    pass

            # also check one/two free flags
            if not offer_text:
                if p.get('one_piece_one_free') == 1 or p.get('one_piece_one_free') == '1':
                    offer_text = "اشتري 1 واحصل على 1 مجاناً"
                elif p.get('two_piece_one_free') == 1 or p.get('two_piece_one_free') == '1':
                    offer_text = "اشتري 2 واحصل على 1 مجاناً"

            try:
                item = {
                    'store': 'Moaz Pharma',
                    'name': name,
                    'price': float(price_val),
                    'image': img_url,
                    'link': link,
                    'offer': offer_text,
                    '_price_is_discounted': bool(p.get('has_discount')),
                }
                enrich_item(item, raw_hit=p)
                results.append(item)
            except Exception:
                pass
    except Exception as e:
        print(f"Moaz error: {e}")
    apply_image_hashes_async(results)
    return results


# ── PharmaBrand via Salla API (api.salla.dev) ─────────────────────────────────

def scrape_pharmabrand(query):
    results = []
    try:
        # Primary: Salla Storefront API (lightweight JSON, no JS needed)
        # Discovered via playwright: requires store-identifier header 1107906432
        api_url = f"https://api.salla.dev/store/v1/products?source=search&filterable=1&filters[q]={urllib.parse.quote(query)}&source_value={urllib.parse.quote(query)}"
        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'application/json',
            'Accept-Language': 'ar',
            'Referer': 'https://pharmabrand.sa/',
            'store-identifier': '1107906432',
            'Currency': 'SAR',
            'X-Requested-With': 'XMLHttpRequest',
        }
        res = requests.get(api_url, headers=headers, timeout=15)
        if res.status_code == 200:
            try:
                data = res.json()
                products = data.get('data', [])
                for p in products[:50]:
                    name = p.get('name', '').strip()
                    if not name:
                        continue
                    # price: use regular_price as base when on sale (frontend applies discount via offer)
                    price_val = None
                    if p.get('is_on_sale') and p.get('regular_price') and p.get('sale_price'):
                        try:
                            rp = float(p.get('regular_price', 0))
                            sp = float(p.get('sale_price', 0))
                            if rp and rp > 0 and sp and sp > 0 and rp > sp:
                                # Use sale_price as the price (it's the real selling price)
                                # Store regular_price in offer text for display
                                price_val = sp
                        except:
                            pass
                    if price_val is None and p.get('is_on_sale') and p.get('sale_price'):
                        try:
                            sp = float(p.get('sale_price', 0))
                            if sp and sp > 0:
                                price_val = sp
                        except:
                            pass
                    if price_val is None:
                        # try price, regular_price
                        for key in ('price', 'regular_price'):
                            try:
                                v = float(p.get(key, 0) or 0)
                                if v and v > 0:
                                    price_val = v
                                    break
                            except:
                                continue
                    if not price_val or price_val <= 0:
                        continue

                    # image
                    img_url = ''
                    if isinstance(p.get('image'), dict):
                        img_url = p['image'].get('url', '')
                    elif isinstance(p.get('original_image'), str):
                        img_url = p.get('original_image', '')
                    if not img_url and p.get('images'):
                        imgs = p.get('images', [])
                        if isinstance(imgs, list) and len(imgs) > 0:
                            first = imgs[0]
                            img_url = first.get('url', '') if isinstance(first, dict) else str(first)

                    link = p.get('url', '') or f"https://pharmabrand.sa/ar/search?q={urllib.parse.quote(query)}"
                    if link and not link.startswith('http'):
                        link = 'https://pharmabrand.sa' + link

                    offer_text = ''
                    # detect sale — price is already the sale_price, so show original price as info only
                    if p.get('is_on_sale') and p.get('regular_price') and p.get('sale_price'):
                        try:
                            reg = float(p.get('regular_price', 0))
                            sale = float(p.get('sale_price', 0))
                            if reg > sale and sale > 0:
                                pct = int(round((reg - sale) / reg * 100))
                                if pct > 0:
                                    offer_text = f"عرض خاص (بدلاً من {reg:.2f} SAR)"
                                else:
                                    offer_text = f"عرض خاص {sale:.2f} SAR"
                        except:
                            pass
                    if not offer_text and p.get('promotion_title'):
                        promo = p.get('promotion_title', '').strip()
                        if promo:
                            offer_text = promo[:80]

                    try:
                        item = {
                            'store': 'PharmaBrand',
                            'name': name,
                            'price': float(price_val),
                            'image': img_url,
                            'link': link,
                            'offer': offer_text,
                        }
                        enrich_item(item, raw_hit=p)
                        results.append(item)
                    except Exception:
                        pass
                if results:
                    apply_image_hashes_async(results)
                    return results
            except Exception as e:
                print(f"PharmaBrand API parse error: {e}")

        # Fallback: cloudscraper + HTML schema (if API fails)
        try:
            scraper = cloudscraper.create_scraper()
            url = f"https://pharmabrand.sa/ar/search?q={urllib.parse.quote(query)}"
            res2 = scraper.get(url, timeout=20)
            if res2.status_code == 200:
                soup = BeautifulSoup(res2.text, 'html.parser')
                script = soup.find('script', id='salla-product-schema-script')
                if script and script.string:
                    data = json.loads(script.string.strip())
                    elements = data.get('itemListElement', [])
                    for el in elements[:50]:
                        prod = el.get('item', {}) if isinstance(el, dict) else {}
                        name = prod.get('name', '').strip()
                        if not name:
                            continue
                        offers = prod.get('offers', {})
                        price_val = offers.get('price', 0)
                        try:
                            price_val = float(price_val)
                        except:
                            continue
                        if not price_val or price_val <= 0:
                            continue
                        img_url = prod.get('image', '') or ''
                        link = prod.get('url', '') or url
                        if link and not link.startswith('http'):
                            link = 'https://pharmabrand.sa' + link
                        try:
                            item = {
                                'store': 'PharmaBrand',
                                'name': name,
                                'price': float(price_val),
                                'image': img_url,
                                'link': link,
                                'offer': '',
                            }
                            enrich_item(item, raw_hit=prod)
                            results.append(item)
                        except:
                            pass
                    if results:
                        apply_image_hashes_async(results)
                        return results
        except Exception as fe:
            print(f"PharmaBrand fallback error: {fe}")

    except Exception as e:
        print(f"PharmaBrand error: {e}")
    apply_image_hashes_async(results)
    return results


# ── Flask Routes ──────────────────────────────────────────────────────────────

@app.route('/')
def index():
    return render_template('index.html', app_version=APP_VERSION)


@app.route('/api/search')
def search():
    """Server-Sent Events endpoint — streams results per-pharmacy as they complete."""
    query = request.args.get('q', '').strip()
    if not query:
        return Response("data: DONE\n\n", mimetype='text/event-stream')

    def generate():
        import time
        qkey = query.lower().strip()
        # serve from cache if fresh (<10m)
        with _search_cache_lock:
            cached = _search_cache.get(qkey)
            if cached and time.time() - cached['ts'] < CACHE_TTL:
                for store_name, results in cached['data']:
                    payload = json.dumps({'store': store_name, 'results': results}, ensure_ascii=False)
                    yield f"data: {payload}\n\n"
                yield "data: DONE\n\n"
                return

        scrapers = [
            ('United Pharmacy', scrape_united),
            ('Nahdi Online',    scrape_nahdi),
            ('Al-Dawaa',        scrape_aldawaa),
            ('Moaz Pharma',     scrape_moaz),
            ('PharmaBrand',     scrape_pharmabrand),
        ]

        collected = []
        try:
            with concurrent.futures.ThreadPoolExecutor(max_workers=5) as executor:
                futures = {
                    executor.submit(fn, query): name
                    for name, fn in scrapers
                }

                for future in concurrent.futures.as_completed(futures, timeout=50):
                    store_name = futures[future]
                    try:
                        results = future.result(timeout=40)
                        # strict relevance filter — drop products not containing query
                        results = [r for r in results if is_relevant(r.get('name',''), query)]
                        apply_ai_fields(results)
                        collected.append((store_name, results))
                        payload = json.dumps(
                            {'store': store_name, 'results': results},
                            ensure_ascii=False
                        )
                        yield f"data: {payload}\n\n"
                    except concurrent.futures.TimeoutError:
                        print(f"Timeout [{store_name}]")
                        yield f"data: {json.dumps({'store': store_name, 'results': [], 'error': 'timeout'})}\n\n"
                    except Exception as e:
                        print(f"Future error [{store_name}]: {e}")
                        yield f"data: {json.dumps({'store': store_name, 'results': [], 'error': str(e)})}\n\n"
        except concurrent.futures.TimeoutError:
            print("Overall executor timeout")
        except Exception as e:
            print(f"Generator error: {e}")

        # save to cache
        if collected:
            with _search_cache_lock:
                import time as _t
                _search_cache[qkey] = {'ts': _t.time(), 'data': collected}

        yield "data: DONE\n\n"

    return Response(
        stream_with_context(generate()),
        mimetype='text/event-stream',
        headers={
            'Cache-Control': 'no-cache',
            'X-Accel-Buffering': 'no',
            'Access-Control-Allow-Origin': '*'
        }
    )


# ── Best Deals / Featured Endpoint ────────────────────────────────────────────

POPULAR_QUERIES = [
    'Panadol', 'فيفادول', 'بروفين', 'سولبادين',
    'كلاريتين', 'جافيسكون', 'حفاضات', 'سنتروم',
    'اوميغا 3', 'عرض'
]
_deals_cache = None
_deals_cache_time = 0
_deals_refreshing = False

@app.route('/api/deals')
def deals():
    """Returns deals — serves cached data immediately, refreshes in background."""
    import time
    import threading
    global _deals_cache, _deals_cache_time, _deals_refreshing

    now = time.time()
    # Serve cache immediately if available (up to 1 hour stale)
    if _deals_cache and (now - _deals_cache_time) < 3600:
        if (now - _deals_cache_time) > 900 and not _deals_refreshing:
            _deals_refreshing = True
            threading.Thread(target=_refresh_deals, daemon=True).start()
        return Response(json.dumps(_deals_cache, ensure_ascii=False), mimetype='application/json')

    # No cache — trigger background refresh, return empty (frontend will retry)
    if not _deals_refreshing:
        _deals_refreshing = True
        threading.Thread(target=_refresh_deals, daemon=True).start()
    return Response(json.dumps([], ensure_ascii=False), mimetype='application/json')


def _refresh_deals():
    """Background refresh of deals cache — populates incrementally."""
    global _deals_cache, _deals_cache_time, _deals_refreshing
    import time
    try:
        seen_links = set()

        def run_popular(query):
            items = []
            with concurrent.futures.ThreadPoolExecutor(max_workers=5) as _ex:
                _futs = {_ex.submit(fn, query): fn.__name__ for fn in (scrape_united, scrape_nahdi, scrape_aldawaa, scrape_moaz, scrape_pharmabrand)}
                for _f in concurrent.futures.as_completed(_futs, timeout=60):
                    try:
                        r = _f.result()
                        if r:
                            items.extend(r)
                    except Exception:
                        continue
            return items

        def rebuild_cache(all_items):
            """Re-deduplicate and sort the full list into a cache snapshot."""
            def item_key(item):
                tokens = item['name'].split(' ')
                brand = tokens[0].lower().replace('ـ', '') if tokens else ''
                qty = item.get('quantity') or ''
                return f"{brand}_{qty}"
            offer_items = []
            seen_keys = set()
            for item in all_items:
                key = item_key(item)
                store_key = f"{item.get('store','')}_{key}"
                if item.get('offer') and store_key not in seen_keys:
                    seen_keys.add(store_key)
                    offer_items.append(item)
            offer_items.sort(key=lambda i: i.get('unit_price') or i['price'])
            return offer_items[:300]

        all_items = []
        with concurrent.futures.ThreadPoolExecutor(max_workers=10) as ex:
            futures = {ex.submit(run_popular, q): q for q in POPULAR_QUERIES}
            for f in concurrent.futures.as_completed(futures):
                try:
                    items = f.result()
                    for item in items:
                        if item['link'] not in seen_links:
                            seen_links.add(item['link'])
                            all_items.append(item)
                    # Incrementally update cache so frontend gets data sooner
                    _deals_cache = rebuild_cache(all_items)
                    _deals_cache_time = time.time()
                except Exception:
                    continue

    except Exception as e:
        print(f"Deals refresh error: {e}")
    finally:
        _deals_refreshing = False


# Pre-warm deals cache on startup
import threading as _t
_t.Thread(target=_refresh_deals, daemon=True).start()

if __name__ == '__main__':
    import os
    port = int(os.environ.get('PORT', 5050))
    app.run(debug=False, host='0.0.0.0', port=port, threaded=True, use_reloader=False)
