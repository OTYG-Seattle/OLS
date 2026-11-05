from __future__ import annotations

from pathlib import Path
from typing import Any, Optional, Union


def package_qualifier(reference: str) -> Optional[tuple[str, str]]:
    """Split a package-qualified reference (``<package>:<id>``) into ``(package, id)``.

    Returns ``None`` for local IDs, URNs, and file references.
    """
    if reference.startswith("urn:") or "/" in reference:
        return None
    separator = reference.find(":")
    if separator <= 0 or separator == len(reference) - 1:
        return None
    return reference[:separator], reference[separator + 1 :]


def resolve_reference(
    reference: str,
    index: dict[str, dict[str, Any]],
    package_root: Optional[Union[str, Path]] = None,
    source: Optional[Union[str, Path]] = None,
    package_name: Optional[str] = None,
) -> Optional[dict[str, Any]]:
    """Resolve a reference against the package index.

    Mirrors ``resolveReference`` in ``@openliturgy/sdk``:

    - An exact ID match always wins.
    - ``<package>:<id>`` resolves locally only when ``<package>`` is this package
      (``package_name``); references into other packages are never satisfied by a
      same-named local entity.
    - ``urn:ols:<ref>`` resolves ``<ref>`` with the same rules, falling back to the
      legacy mapping that replaces ``:`` with ``.``.
    - Paths resolve to a document inside the package root.
    """
    if reference in index:
        return index[reference]
    if reference.startswith("urn:ols:"):
        rest = reference[8:]
        resolved = resolve_reference(rest, index, package_root, source, package_name)
        return resolved if resolved is not None else index.get(rest.replace(":", "."))
    if ("/" in reference or reference.endswith(".json")) and package_root and source:
        root = Path(package_root).resolve()
        candidate = (Path(source).parent / reference).resolve()
        try:
            candidate.relative_to(root)
        except ValueError:
            return None
        return next(
            (item for item in index.values() if Path(str(item.get("__source", ""))).resolve() == candidate), None
        )
    qualified = package_qualifier(reference)
    if qualified is not None and package_name and qualified[0] == package_name:
        return index.get(qualified[1])
    return None
