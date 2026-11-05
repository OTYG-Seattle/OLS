"""Entity-addressed change sets: diff, apply, and combine. Mirrors ``packages/sdk/src/changes.ts``."""

from __future__ import annotations

import copy
import re
from typing import Any

from .integrity import canonicalize

_INDEX = re.compile(r"^(0|[1-9][0-9]*)$")
_ARRAY_TOKEN = re.compile(r"^(-|0|[1-9][0-9]*)$")


class ChangeError(Exception):
    """A change could not be applied. ``index`` is the failing operation's position, when known."""

    def __init__(self, message: str, index: int | None = None) -> None:
        super().__init__(message)
        self.index = index


def _utf16(text: str) -> bytes:
    return text.encode("utf-16-be")


def escape_token(token: str) -> str:
    return token.replace("~", "~0").replace("/", "~1")


def _equal(a: Any, b: Any) -> bool:
    return canonicalize(a) == canonicalize(b)


def parse_pointer(pointer: str) -> list[str]:
    if pointer == "":
        return []
    if not pointer.startswith("/"):
        raise ChangeError(f'Invalid JSON Pointer "{pointer}".')
    return [token.replace("~1", "/").replace("~0", "~") for token in pointer[1:].split("/")]


def _array_index(token: str, length: int, allow_end: bool) -> int:
    if allow_end and token == "-":
        return length
    if not _INDEX.match(token):
        raise ChangeError(f'"{token}" is not an array index.')
    index = int(token)
    if index > length or (not allow_end and index == length):
        raise ChangeError(f"Array index {index} is out of range.")
    return index


def apply_at_pointer(document: Any, op: str, pointer: str, value: Any = None) -> Any:
    """Apply one RFC 6902 operation at ``pointer`` inside ``document``; return the (possibly new) root."""
    tokens = parse_pointer(pointer)
    if not tokens:
        if op == "test":
            if not _equal(document, value):
                raise ChangeError("Test failed at the document root.")
            return document
        if op == "remove":
            raise ChangeError("Cannot remove the document root.")
        return copy.deepcopy(value)
    parent = document
    for token in tokens[:-1]:
        if isinstance(parent, list):
            parent = parent[_array_index(token, len(parent), False)]
        elif isinstance(parent, dict) and token in parent:
            parent = parent[token]
        else:
            raise ChangeError(f"Path {pointer} does not exist.")
    last = tokens[-1]
    if isinstance(parent, list):
        index = _array_index(last, len(parent), op == "add")
        if op == "add":
            parent.insert(index, copy.deepcopy(value))
        elif op == "remove":
            del parent[index]
        elif op == "replace":
            parent[index] = copy.deepcopy(value)
        elif not _equal(parent[index], value):
            raise ChangeError(f"Test failed at {pointer}.")
    elif isinstance(parent, dict):
        if op != "add" and last not in parent:
            raise ChangeError(f"Path {pointer} does not exist.")
        if op in ("add", "replace"):
            parent[last] = copy.deepcopy(value)
        elif op == "remove":
            del parent[last]
        elif not _equal(parent[last], value):
            raise ChangeError(f"Test failed at {pointer}.")
    else:
        raise ChangeError(f"Path {pointer} does not exist.")
    return document


def entity_pointers(document: Any) -> dict[str, str]:
    """Pointers of every entity (object with a string ``id``) in a document, keyed by ID (first occurrence wins)."""
    found: dict[str, str] = {}

    def visit(value: Any, pointer: str) -> None:
        if isinstance(value, list):
            for i, item in enumerate(value):
                visit(item, f"{pointer}/{i}")
        elif isinstance(value, dict):
            if isinstance(value.get("id"), str) and value["id"] not in found:
                found[value["id"]] = pointer
            for key, item in value.items():
                if key == "$ref" or (key == "operations" and value.get("type") == "overlay"):
                    continue
                visit(item, f"{pointer}/{escape_token(key)}")

    visit(document, "")
    return found


def _unique_ids(items: list[Any]) -> list[str] | None:
    ids = [item.get("id") if isinstance(item, dict) and isinstance(item.get("id"), str) else None for item in items]
    if any(item is None for item in ids) or len(set(ids)) != len(ids):
        return None
    return [str(item) for item in ids]


def diff_values(before: Any, after: Any, pointer: str = "", out: list[dict[str, Any]] | None = None) -> list[dict[str, Any]]:
    """Deterministic structural diff. Mirrors ``diffValues``."""
    if out is None:
        out = []
    if _equal(before, after):
        return out
    if isinstance(before, dict) and isinstance(after, dict):
        for key in sorted(set(before) | set(after), key=_utf16):
            path = f"{pointer}/{escape_token(key)}"
            if key not in after:
                out.append({"op": "remove", "path": path})
            elif key not in before:
                out.append({"op": "add", "path": path, "value": copy.deepcopy(after[key])})
            else:
                diff_values(before[key], after[key], path, out)
        return out
    if isinstance(before, list) and isinstance(after, list):
        before_ids, after_ids = _unique_ids(before), _unique_ids(after)
        if before_ids is not None and after_ids is not None:
            kept, original = set(after_ids), set(before_ids)
            common = [item for item in before_ids if item in kept]
            if common == [item for item in after_ids if item in original]:
                for i in range(len(before) - 1, -1, -1):
                    if before_ids[i] not in kept:
                        out.append({"op": "remove", "path": f"{pointer}/{i}"})
                for i, item_id in enumerate(before_ids):
                    if item_id in kept:
                        diff_values(before[i], after[after_ids.index(item_id)], f"{pointer}/{i}", out)
                for j, item_id in enumerate(after_ids):
                    if item_id not in original:
                        out.append({"op": "add", "path": f"{pointer}/{j}", "value": copy.deepcopy(after[j])})
                return out
        elif len(before) == len(after):
            for i, item in enumerate(before):
                diff_values(item, after[i], f"{pointer}/{i}", out)
            return out
    out.append({"op": "replace", "path": pointer, "value": copy.deepcopy(after)})
    return out


def target_operations(document: str, base: Any, operations: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Re-address document-absolute operations to the innermost entity strictly containing them. Mirrors ``targetOperations``."""
    pointers = sorted(entity_pointers(base).items(), key=lambda item: -len(item[1]))
    changes: list[dict[str, Any]] = []
    for operation in operations:
        path = operation["path"]
        owner = next((item for item in pointers if path.startswith(item[1] + "/")), None)
        change: dict[str, Any] = (
            {"op": operation["op"], "entity": owner[0], "path": path[len(owner[1]) :]}
            if owner is not None
            else {"op": operation["op"], "document": document, "path": path}
        )
        if operation["op"] != "remove":
            change["value"] = operation.get("value")
        changes.append(change)
    return changes


def find_entity(documents: dict[str, Any], entity_id: str) -> tuple[str, str] | None:
    for name in sorted(documents, key=_utf16):
        pointer = entity_pointers(documents[name]).get(entity_id)
        if pointer is not None:
            return name, pointer
    return None


def apply_changes(documents: dict[str, Any], operations: list[dict[str, Any]]) -> None:
    """Apply a change set to a mapping of package-relative paths to parsed documents (mutated in place)."""
    for i, change in enumerate(operations):
        try:
            op, path, value = str(change.get("op")), str(change.get("path", "")), change.get("value")
            if change.get("entity") is not None:
                location = find_entity(documents, change["entity"])
                if location is None:
                    raise ChangeError(f"Entity {change['entity']} does not exist.")
                name, pointer = location
                documents[name] = apply_at_pointer(documents[name], op, pointer + path, value)
            elif change.get("document") is not None:
                name = change["document"]
                if path == "" and op == "add":
                    if name in documents:
                        raise ChangeError(f"Document {name} already exists.")
                    documents[name] = copy.deepcopy(value)
                elif path == "" and op == "remove":
                    if name not in documents:
                        raise ChangeError(f"Document {name} does not exist.")
                    del documents[name]
                else:
                    if name not in documents:
                        raise ChangeError(f"Document {name} does not exist.")
                    documents[name] = apply_at_pointer(documents[name], op, path, value)
            else:
                raise ChangeError("An operation must target an entity or a document.")
        except ChangeError as error:
            target = change.get("entity") if change.get("entity") is not None else change.get("document")
            raise ChangeError(f"Operation {i} ({change.get('op')} {target}{change.get('path', '')}): {error}", i) from error


def _target_key(change: dict[str, Any]) -> str:
    return f"entity:{change['entity']}" if change.get("entity") is not None else f"document:{change.get('document')}"


def _overlaps(a: str, b: str) -> bool:
    return a == b or a.startswith(b + "/") or b.startswith(a + "/")


def _array_parent(change: dict[str, Any]) -> str | None:
    if change["op"] not in ("add", "remove"):
        return None
    tokens = parse_pointer(change["path"])
    if tokens and _ARRAY_TOKEN.match(tokens[-1]):
        return str(change["path"][: change["path"].rfind("/")])
    return None


def combine_changes(ours: list[dict[str, Any]], theirs: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Combine two change sets against the same base. Returns ``(operations, conflicts)``. Mirrors ``combineChanges``."""
    conflicts: list[dict[str, Any]] = []
    extra: list[dict[str, Any]] = []
    ours_text = [canonicalize(mine) for mine in ours]
    for other in theirs:
        if canonicalize(other) in ours_text:
            continue
        clash = next(
            (
                mine
                for mine in ours
                if _target_key(mine) == _target_key(other)
                and (
                    _overlaps(mine["path"], other["path"])
                    or (_array_parent(mine) is not None and _array_parent(mine) == _array_parent(other))
                )
            ),
            None,
        )
        if clash is not None:
            conflicts.append({"ours": clash, "theirs": other})
        else:
            extra.append(other)
    return [*ours, *extra], conflicts
