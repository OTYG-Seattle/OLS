from __future__ import annotations

import hashlib
import json
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from jsonschema.validators import Draft202012Validator


def load_context() -> dict[str, Any]:
    """The OLS JSON-LD context (``@context`` document) that maps OLS JSON to linked data."""
    context: dict[str, Any] = json.loads(
        Path(__file__).with_name("_schemas").joinpath("context.jsonld").read_text(encoding="utf-8")
    )
    return context


class SchemaRegistry:
    def __init__(self, schemas: dict[str, dict[str, Any]]) -> None:
        self.schemas = schemas

    @classmethod
    def bundled(cls) -> SchemaRegistry:
        directory = Path(__file__).with_name("_schemas")
        schemas: dict[str, dict[str, Any]] = {}
        for path in sorted(directory.glob("*.schema.json")):
            schema = json.loads(path.read_text(encoding="utf-8"))
            schemas[schema["$id"]] = schema
        return cls(schemas)

    def get(self, schema_id: str) -> dict[str, Any] | None:
        return self.schemas.get(schema_id)

    def validator(self, schema_id: str) -> Draft202012Validator | None:
        schema = self.get(schema_id)
        return Draft202012Validator(schema) if schema else None

    def refresh(self, cache_directory: str | Path, base_url: str = "https://ols.otyg.org/schema/v1.0/") -> None:
        cache = Path(cache_directory).expanduser().resolve()
        cache.mkdir(parents=True, exist_ok=True)
        for schema in self.schemas.values():
            filename = str(schema["$id"]).rsplit("/", 1)[-1]
            metadata_path = cache / f"{filename}.metadata.json"
            metadata = json.loads(metadata_path.read_text()) if metadata_path.exists() else {}
            request = urllib.request.Request(base_url + filename, headers={"If-None-Match": metadata.get("etag", "")})
            try:
                with urllib.request.urlopen(request) as response:
                    body = response.read()
                    remote = json.loads(body)
                    if remote.get("$id") != base_url + filename:
                        raise ValueError(f"{filename}: unexpected $id")
                    (cache / filename).write_text(json.dumps(remote, indent=2) + "\n", encoding="utf-8")
                    metadata_path.write_text(
                        json.dumps(
                            {
                                "url": base_url + filename,
                                "etag": response.headers.get("ETag", ""),
                                "sha256": hashlib.sha256(body).hexdigest(),
                            },
                            indent=2,
                        )
                        + "\n",
                        encoding="utf-8",
                    )
            except urllib.error.HTTPError as error:
                if error.code != 304:
                    raise
