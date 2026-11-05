from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .models import OlsDocument

DEFAULT_PACKAGES_DIRECTORY = "ols_packages"
"""Directory, relative to a package root, holding its resolved dependencies (skipped when loading the package)."""


@dataclass(frozen=True)
class LoadedDocument:
    source: str
    raw_text: str
    raw: Any
    data: OlsDocument | None


def _normal(path: Path) -> str:
    return path.as_posix()


def load_document(source: str | Path) -> LoadedDocument:
    path = Path(source).resolve()
    text = path.read_text(encoding="utf-8")
    try:
        raw = json.loads(text)
    except json.JSONDecodeError:
        return LoadedDocument(_normal(path), text, None, None)
    data = None
    if isinstance(raw, dict) and all(key in raw for key in ("$schema", "ols_version", "type")):
        try:
            data = OlsDocument.model_validate(raw)
        except ValueError:
            data = None
    return LoadedDocument(_normal(path), text, raw, data)


def load_package(root: str | Path) -> list[LoadedDocument]:
    directory = Path(root).resolve()
    files = sorted(
        path
        for path in directory.rglob("*.json")
        if not {"tests", DEFAULT_PACKAGES_DIRECTORY} & set(path.relative_to(directory).parent.parts)
        and not path.name.endswith(".expected.json")
    )
    manifest = directory / "manifest.ols.json"
    files.sort(key=lambda path: (path != manifest, path.as_posix()))
    return [load_document(path) for path in files]
