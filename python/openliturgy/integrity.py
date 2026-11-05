"""OLS canonical JSON and digests. Mirrors ``packages/sdk/src/integrity.ts``."""

from __future__ import annotations

import hashlib
import itertools
import json
import math
import re
import unicodedata
from typing import Any

DIGEST_PATTERN = re.compile(r"^sha256:[0-9a-f]{64}$")
PACKAGE_DIGEST_EXCLUDED_KEYS = ("digest", "signatures")
_SCHEME = re.compile(r"^[A-Za-z][A-Za-z0-9+.-]*:")
_MAX_SAFE_INTEGER = 2**53


def _ecmascript_number(value: float) -> str:
    """Format a finite float with the ECMAScript Number::toString algorithm (RFC 8785, section 3.2.2.3)."""
    if math.isnan(value) or math.isinf(value):
        raise ValueError("Canonical JSON cannot represent NaN or Infinity.")
    if value == 0:
        return "0"
    sign = "-" if value < 0 else ""
    mantissa, _, exponent_text = repr(abs(value)).partition("e")
    exponent = int(exponent_text) if exponent_text else 0
    integer_part, _, fraction = mantissa.partition(".")
    digits = (integer_part + fraction).lstrip("0")
    stripped = digits.rstrip("0")
    trailing = len(digits) - len(stripped)
    digits = stripped
    k = len(digits)
    # value = digits * 10 ** (n - k)
    n = exponent - len(fraction) + trailing + k
    if k <= n <= 21:
        text = digits + "0" * (n - k)
    elif 0 < n <= 21:
        text = digits[:n] + "." + digits[n:]
    elif -6 < n <= 0:
        text = "0." + "0" * (-n) + digits
    else:
        e = n - 1
        text = (digits if k == 1 else digits[0] + "." + digits[1:]) + "e" + ("+" if e > 0 else "-") + str(abs(e))
    return sign + text


_LONE_SURROGATE = re.compile("[\ud800-\udfff]")


def _string(value: str) -> str:
    text = json.dumps(unicodedata.normalize("NFC", value), ensure_ascii=False)
    # Match JSON.stringify, which escapes unpaired surrogates instead of emitting invalid UTF-8.
    return _LONE_SURROGATE.sub(lambda match: f"\\u{ord(match.group()):04x}", text)


def canonicalize(value: Any) -> str:
    """OLS canonical JSON: RFC 8785 (JCS) after Unicode NFC normalization of strings and member names."""
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, int):
        # JSON numbers are IEEE doubles; integers beyond 2**53 are rounded exactly as JavaScript reads them.
        return str(value) if abs(value) <= _MAX_SAFE_INTEGER else _ecmascript_number(float(value))
    if isinstance(value, float):
        return _ecmascript_number(value)
    if isinstance(value, str):
        return _string(value)
    if isinstance(value, (list, tuple)):
        return "[" + ",".join(canonicalize(item) for item in value) + "]"
    if isinstance(value, dict):
        entries = [(unicodedata.normalize("NFC", str(key)), item) for key, item in value.items()]
        # Sort by UTF-16 code units, as RFC 8785 requires.
        entries.sort(key=lambda entry: entry[0].encode("utf-16-be"))
        for previous, current in itertools.pairwise(entries):
            if previous[0] == current[0]:
                raise ValueError(f'Member name "{current[0]}" is duplicated after NFC normalization.')
        return "{" + ",".join(f"{_string(key)}:{canonicalize(item)}" for key, item in entries) + "}"
    raise ValueError(f"Canonical JSON cannot represent a value of type {type(value).__name__}.")


def bytes_digest(data: bytes) -> str:
    """``sha256:<hex>`` of raw bytes (used for binary assets)."""
    return "sha256:" + hashlib.sha256(data).hexdigest()


def canonical_digest(value: Any) -> str:
    """``sha256:<hex>`` of a JSON value's canonical form (used for OLS documents)."""
    return bytes_digest(canonicalize(value).encode("utf-8"))


def package_digest(manifest: dict[str, Any]) -> str:
    """Digest of the package: the canonical manifest without ``digest`` and ``signatures``."""
    return canonical_digest({key: item for key, item in manifest.items() if key not in PACKAGE_DIGEST_EXCLUDED_KEYS})


def manifest_file_entries(files: Any) -> list[dict[str, Any]]:
    """Normalize ``manifest.files``, whose entries may be a bare path or ``{path, digest, mediaType}``."""
    if not isinstance(files, list):
        return []
    entries: list[dict[str, Any]] = []
    for entry in files:
        if isinstance(entry, str):
            entries.append({"path": entry})
        elif isinstance(entry, dict) and isinstance(entry.get("path"), str):
            entries.append(entry)
    return entries


def is_package_relative_uri(uri: str) -> bool:
    """True when ``uri`` has no scheme, i.e. it is resolved from the package root."""
    return not _SCHEME.match(uri) and not uri.startswith("//")
