"""Arabic-aware text matching for server-side search over opened content.

Same normalization as the old client index: drop diacritics and tatweel,
unify alef/yaa/taa-marbuta forms and Arabic-Indic digits. Every query word
must appear in at least one field (AND over words, substring match).
"""
import re
import unicodedata

_DIACRITICS = re.compile("[ؐ-ًؚ-ٰٟۖ-ۭ]")
_TABLE = str.maketrans({
    "آ": "ا", "أ": "ا", "إ": "ا", "ٱ": "ا",
    "ى": "ي", "ة": "ه", "ؤ": "و", "ئ": "ي", "ـ": None,
    **{chr(0x0660 + d): str(d) for d in range(10)},
    **{chr(0x06F0 + d): str(d) for d in range(10)},
})


def normalize(text: str) -> str:
    text = unicodedata.normalize("NFKC", text or "")
    return _DIACRITICS.sub("", text).translate(_TABLE).lower()


def matches(query: str, *fields: str) -> bool:
    words = normalize(query).split()
    if not words:
        return False
    haystack = "\n".join(normalize(f) for f in fields if f)
    for word in words:
        if word in haystack:
            continue
        if len(word) > 4 and word.startswith("ال") and word[2:] in haystack:
            continue
        return False
    return True
