from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

Layer = Literal["parse", "schema-selection", "structural", "consistency", "references", "semantic"]
Severity = Literal["error", "warning", "info"]


class OlsDocument(BaseModel):
    model_config = ConfigDict(extra="allow", populate_by_name=True)
    schema_uri: str = Field(alias="$schema")
    ols_version: str
    type: str
    kind: str | None = None
    id: str | None = None
    status: str | None = None


class Diagnostic(BaseModel):
    layer: Layer
    source: str
    entityId: str | None = None
    jsonPointer: str = ""
    code: str
    message: str
    severity: Severity
    details: dict[str, Any] | None = None


class ValidationReport(BaseModel):
    valid: bool
    diagnostics: list[Diagnostic]
    filesChecked: list[str]
    schemaVersions: list[str]
    skippedLayers: list[Layer]
