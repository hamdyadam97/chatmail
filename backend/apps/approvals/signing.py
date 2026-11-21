"""Signed requests (user decision 2026-11-21): an employee uploads a request
file (expense, leave…); each approver who approves stamps their saved
handwritten signature, name and time at the bottom of the page they choose.

Everything happens in memory; the result is sealed like any other file
(correspondence.services.store_blob). The signature is a picture of a
handwriting, not a certified digital signature: what proves who approved is
the decision row (approver, time, content hash) and the audit log.
"""
import io
from functools import lru_cache
from pathlib import Path

from rest_framework.exceptions import ValidationError

MAX_PAGES = 50
MAX_SIGNATURE_BYTES = 300 * 1024
FONT_PATH = Path(__file__).resolve().parent / "fonts" / "Amiri-Regular.ttf"

# Signature boxes at the bottom of the last page, right to left, 3 per row.
BOX_W, BOX_H, GAP, MARGIN, PER_ROW = 165.0, 92.0, 8.0, 18.0, 3


def _ar(text: str) -> str:
    """Arabic in visual order with joined letters (fpdf2 draws glyphs as given)."""
    import arabic_reshaper
    from bidi import get_display

    return get_display(arabic_reshaper.reshape(text or ""))


@lru_cache(maxsize=1)
def _font_bytes() -> bytes:
    return FONT_PATH.read_bytes()


# --- the request file ------------------------------------------------------------------------

def to_pdf(data: bytes) -> bytes:
    """The uploaded request as a PDF: a PDF is checked as is; a photo or scan
    (JPEG/PNG) becomes a one-page PDF."""
    from pypdf import PdfReader

    if data[:5] == b"%PDF-":
        try:
            reader = PdfReader(io.BytesIO(data))
            if reader.is_encrypted:
                raise ValidationError({"file": "الملف محمي بكلمة مرور — ارفع نسخة بدون حماية."})
            pages = len(reader.pages)
        except ValidationError:
            raise
        except Exception:
            raise ValidationError({"file": "ملف PDF تالف أو غير مقروء."})
        if not 1 <= pages <= MAX_PAGES:
            raise ValidationError({"file": f"من صفحة إلى {MAX_PAGES} صفحة."})
        return data
    from PIL import Image, UnidentifiedImageError

    try:
        img = Image.open(io.BytesIO(data))
        if img.format not in ("JPEG", "PNG"):
            raise UnidentifiedImageError
        img.load()
    except (UnidentifiedImageError, OSError):
        raise ValidationError({"file": "ارفع ملف PDF أو صورة (JPG/PNG)."})
    if img.width * img.height > 40_000_000:
        raise ValidationError({"file": "الصورة كبيرة جدًا."})
    out = io.BytesIO()
    img.convert("RGB").save(out, "PDF", resolution=150)
    return out.getvalue()


# --- the saved signature ---------------------------------------------------------------------

def clean_signature(data: bytes) -> bytes:
    """A drawn/uploaded signature re-encoded as a plain PNG (no metadata),
    at most 1200×600."""
    from PIL import Image, UnidentifiedImageError

    if not data or len(data) > MAX_SIGNATURE_BYTES:
        raise ValidationError({"image": "صورة التوقيع فارغة أو أكبر من 300 ك.ب."})
    try:
        img = Image.open(io.BytesIO(data))
        if img.format not in ("PNG", "JPEG"):
            raise UnidentifiedImageError
        img.load()
    except (UnidentifiedImageError, OSError):
        raise ValidationError({"image": "صورة التوقيع غير صالحة (PNG أو JPG)."})
    img = img.convert("RGBA")
    img.thumbnail((1200, 600))
    bbox = img.getbbox()  # trim empty margins so the stamp is the ink itself
    if bbox is None:
        raise ValidationError({"image": "التوقيع فارغ."})
    img = img.crop(bbox)
    out = io.BytesIO()
    img.save(out, "PNG", optimize=True)
    return out.getvalue()


# --- stamping --------------------------------------------------------------------------------

def page_count(pdf: bytes) -> int:
    from pypdf import PdfReader

    return len(PdfReader(io.BytesIO(pdf)).pages)


def stamp(pdf: bytes, *, signature_png: bytes, name: str, role: str, when: str, reference: str, slot: int,
          page: int | None = None) -> bytes:
    """`pdf` with one more signature box at the bottom of page `page`
    (1-based; default the last). `slot` = signatures already on that page."""
    from fpdf import FPDF
    from pypdf import PdfReader, PdfWriter

    reader = PdfReader(io.BytesIO(pdf))
    index = (page - 1) if page else len(reader.pages) - 1
    if not 0 <= index < len(reader.pages):
        raise ValidationError({"page": f"اختر صفحة من 1 إلى {len(reader.pages)}."})
    target = reader.pages[index]
    width, height = float(target.mediabox.width), float(target.mediabox.height)

    col, row = slot % PER_ROW, slot // PER_ROW
    x = width - MARGIN - (col + 1) * BOX_W - col * GAP
    y_top = height - MARGIN - (row + 1) * BOX_H - row * GAP  # fpdf: y grows downwards
    if x < 0 or y_top < 0:
        raise ValidationError({"page": "لا مكان لتوقيع إضافي على هذه الصفحة — اختر صفحة أخرى."})

    overlay = FPDF(unit="pt", format=(width, height))
    overlay.set_auto_page_break(False)
    overlay.set_margins(0, 0, 0)
    overlay.add_page()
    overlay.add_font("Amiri", fname=str(FONT_PATH))
    overlay.set_draw_color(150, 150, 150)
    overlay.set_line_width(0.6)
    overlay.rect(x, y_top, BOX_W, BOX_H)
    overlay.image(io.BytesIO(signature_png), x=x + 8, y=y_top + 4, w=BOX_W - 16, h=40, keep_aspect_ratio=True)
    overlay.set_text_color(20, 20, 20)
    overlay.set_font("Amiri", size=10)
    overlay.set_xy(x + 4, y_top + 45)
    overlay.cell(BOX_W - 8, 13, _ar(name), align="C")
    overlay.set_font("Amiri", size=8)
    overlay.set_text_color(80, 80, 80)
    overlay.set_xy(x + 4, y_top + 58)
    overlay.cell(BOX_W - 8, 11, _ar(f"{role} — اعتُمد إلكترونيًا"), align="C")
    overlay.set_xy(x + 4, y_top + 70)
    overlay.cell(BOX_W - 8, 11, f"{when}  ·  {reference}", align="C")

    stamp_page = PdfReader(io.BytesIO(bytes(overlay.output()))).pages[0]
    writer = PdfWriter(clone_from=reader)
    writer.pages[index].merge_page(stamp_page)
    out = io.BytesIO()
    writer.write(out)
    return out.getvalue()
