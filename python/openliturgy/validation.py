from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Iterable, Optional, Union

from .loading import LoadedDocument, load_document, load_package
from .models import Diagnostic, Layer, ValidationReport
from .references import package_qualifier, resolve_reference
from .schemas import SchemaRegistry

LAYERS: list[Layer] = ["parse", "schema-selection", "structural", "consistency", "references", "semantic"]


def _report(
    diagnostics: list[Diagnostic], files: Iterable[str], versions: Iterable[str], skipped: Optional[list[Layer]] = None
) -> ValidationReport:
    diagnostics.sort(key=lambda item: (LAYERS.index(item.layer), item.source, item.jsonPointer, item.code))
    return ValidationReport(
        valid=not any(item.severity == "error" for item in diagnostics),
        diagnostics=diagnostics,
        filesChecked=sorted(set(files)),
        schemaVersions=sorted(set(versions)),
        skippedLayers=skipped or [],
    )


def validate_document(
    value: Union[str, Path, LoadedDocument], registry: Optional[SchemaRegistry] = None
) -> ValidationReport:
    loaded = load_document(value) if isinstance(value, (str, Path)) else value
    diagnostics: list[Diagnostic] = []
    if not isinstance(loaded.raw, dict):
        diagnostics.append(
            Diagnostic(
                layer="parse",
                source=loaded.source,
                code="OLS_JSON_PARSE",
                message="File is not valid JSON object syntax.",
                severity="error",
            )
        )
        return _report(diagnostics, [loaded.source], [], LAYERS[1:])
    schemas = registry or SchemaRegistry.bundled()
    schema_id = loaded.raw.get("$schema")
    schema = schemas.get(schema_id) if isinstance(schema_id, str) else None
    entity_id = loaded.raw.get("id") if isinstance(loaded.raw.get("id"), str) else None
    if schema is None:
        diagnostics.append(
            Diagnostic(
                layer="schema-selection",
                source=loaded.source,
                entityId=entity_id,
                jsonPointer="/$schema",
                code="OLS_SCHEMA_UNSUPPORTED",
                message="The declared schema is missing or unsupported.",
                severity="error",
            )
        )
        return _report(diagnostics, [loaded.source], [], LAYERS[2:])
    assert isinstance(schema_id, str)
    validator = schemas.validator(schema_id)
    errors = sorted(validator.iter_errors(loaded.raw), key=lambda error: list(error.absolute_path)) if validator else []
    for error in errors:
        pointer = "".join(f"/{str(part).replace('~', '~0').replace('/', '~1')}" for part in error.absolute_path)
        details = (
            {"validatorValue": error.validator_value}
            if isinstance(error.validator_value, (str, int, float, bool))
            else None
        )
        diagnostics.append(
            Diagnostic(
                layer="structural",
                source=loaded.source,
                entityId=entity_id,
                jsonPointer=pointer,
                code=f"OLS_SCHEMA_{error.validator.upper().replace('-', '_')}",
                message=error.message,
                severity="error",
                details=details,
            )
        )
    expected_type = schema_id.rsplit("/", 1)[-1].replace(".schema.json", "")
    if loaded.raw.get("type") != expected_type:
        diagnostics.append(
            Diagnostic(
                layer="consistency",
                source=loaded.source,
                entityId=entity_id,
                jsonPointer="/type",
                code="OLS_TYPE_MISMATCH",
                message=f"Expected type {expected_type}.",
                severity="error",
            )
        )
    version = loaded.raw.get("ols_version")
    if not isinstance(version, str) or not (version.startswith("1.0.") and version[4:].isdigit() or version.startswith("1.1.") and version[4:].isdigit()):
        diagnostics.append(
            Diagnostic(
                layer="consistency",
                source=loaded.source,
                entityId=entity_id,
                jsonPointer="/ols_version",
                code="OLS_VERSION_UNSUPPORTED",
                message="Only OLS 1.0.x and 1.1.x are supported.",
                severity="error",
            )
        )
    if schema.get("x-ols-schema-source") == "synthesized":
        diagnostics.append(
            Diagnostic(
                layer="schema-selection",
                source=loaded.source,
                entityId=entity_id,
                jsonPointer="/$schema",
                code="OLS_SCHEMA_PROVISIONAL",
                message="This per-entity schema is provisional.",
                severity="warning",
            )
        )
    if loaded.raw.get("status") == "deprecated":
        diagnostics.append(
            Diagnostic(
                layer="consistency",
                source=loaded.source,
                entityId=entity_id,
                jsonPointer="/status",
                code="OLS_SCHEMA_DEPRECATED",
                message="This document is deprecated.",
                severity="warning",
            )
        )
    diagnostics.extend(_validate_translation_variants(loaded.raw, loaded.source))
    return _report(
        diagnostics,
        [loaded.source],
        [str(schema.get("x-ols-revision", "1.0.0"))],
        ["references", "semantic"] if errors else [],
    )


def _walk(value: Any, source: str, pointer: str = "") -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    entities: list[dict[str, Any]] = []
    refs: list[dict[str, Any]] = []
    if isinstance(value, list):
        for index, item in enumerate(value):
            child_entities, child_refs = _walk(item, source, f"{pointer}/{index}")
            entities.extend(child_entities)
            refs.extend(child_refs)
    elif isinstance(value, dict):
        if isinstance(value.get("id"), str):
            entities.append({"value": value, "source": source, "pointer": pointer})
        if isinstance(value.get("$ref"), str):
            refs.append({"value": value, "source": source, "pointer": pointer})
        for key, child in value.items():
            if key != "$ref":
                child_entities, child_refs = _walk(
                    child, source, f"{pointer}/{key.replace('~', '~0').replace('/', '~1')}"
                )
                entities.extend(child_entities)
                refs.extend(child_refs)
    return entities, refs


def _validate_translation_variants(value: Any, source: str, pointer: str = "") -> list[Diagnostic]:
    """Walk a document tree and validate all translation variant blocks."""
    diagnostics: list[Diagnostic] = []
    if isinstance(value, list):
        for index, item in enumerate(value):
            diagnostics.extend(_validate_translation_variants(item, source, f"{pointer}/{index}"))
    elif isinstance(value, dict):
        text_map = value.get("text")
        variants_map = value.get("variants")
        if isinstance(text_map, dict) and isinstance(variants_map, dict):
            entity_id = value.get("id") if isinstance(value.get("id"), str) else None
            for lang, variant_list in variants_map.items():
                lang_pointer = f"{pointer}/variants/{lang.replace('~', '~0').replace('/', '~1')}"
                if lang not in text_map:
                    diagnostics.append(Diagnostic(
                        layer="consistency", source=source, entityId=entity_id,
                        jsonPointer=lang_pointer, code="OLS_VARIANT_LANG_MISMATCH",
                        message=f"Variant language '{lang}' is not present in the text map.", severity="error",
                    ))
                if not isinstance(variant_list, list) or len(variant_list) == 0:
                    diagnostics.append(Diagnostic(
                        layer="consistency", source=source, entityId=entity_id,
                        jsonPointer=lang_pointer, code="OLS_VARIANT_EMPTY_ARRAY",
                        message=f"Variant array for '{lang}' must contain at least one entry.", severity="error",
                    ))
                    continue
                default_count = 0
                seen_values: list[str] = []
                for idx, variant in enumerate(variant_list):
                    v_pointer = f"{lang_pointer}/{idx}"
                    if not isinstance(variant, dict):
                        continue
                    v_value = variant.get("value")
                    if not isinstance(v_value, str) or not v_value:
                        diagnostics.append(Diagnostic(
                            layer="consistency", source=source, entityId=entity_id,
                            jsonPointer=f"{v_pointer}/value", code="OLS_VARIANT_VALUE_REQUIRED",
                            message="Variant object must have a non-empty 'value' field.", severity="error",
                        ))
                    else:
                        if v_value in seen_values:
                            diagnostics.append(Diagnostic(
                                layer="consistency", source=source, entityId=entity_id,
                                jsonPointer=f"{v_pointer}/value", code="OLS_VARIANT_NO_DUPLICATES",
                                message=f"Duplicate variant value in language '{lang}'.", severity="warning",
                            ))
                        seen_values.append(v_value)
                    if variant.get("default") is True:
                        default_count += 1
                        if default_count > 1:
                            diagnostics.append(Diagnostic(
                                layer="consistency", source=source, entityId=entity_id,
                                jsonPointer=f"{v_pointer}/default", code="OLS_VARIANT_MULTI_DEFAULT",
                                message=f"Multiple defaults declared for language '{lang}'.", severity="error",
                            ))
                        if isinstance(v_value, str) and lang in text_map and v_value != text_map[lang]:
                            diagnostics.append(Diagnostic(
                                layer="consistency", source=source, entityId=entity_id,
                                jsonPointer=f"{v_pointer}/value", code="OLS_VARIANT_DEFAULT_SYNC",
                                message="Default variant value does not match the text map entry.", severity="error",
                            ))
                    if not variant.get("label"):
                        diagnostics.append(Diagnostic(
                            layer="consistency", source=source, entityId=entity_id,
                            jsonPointer=v_pointer, code="OLS_VARIANT_LABEL_RECOMMENDED",
                            message="Variant should include a 'label' for display.", severity="info",
                        ))
                    if not variant.get("source"):
                        diagnostics.append(Diagnostic(
                            layer="consistency", source=source, entityId=entity_id,
                            jsonPointer=v_pointer, code="OLS_VARIANT_SOURCE_RECOMMENDED",
                            message="Variant should include a 'source' for provenance.", severity="info",
                        ))
        for key, child in value.items():
            if key not in ("text", "variants", "textMeta"):
                diagnostics.extend(_validate_translation_variants(
                    child, source, f"{pointer}/{key.replace('~', '~0').replace('/', '~1')}"
                ))
    return diagnostics


ID_REFERENCE_FIELDS: dict[str, list[str]] = {
    "asset": ["linkedTo"],
    "conflict-rule": ["winner", "overrides"],
    "execution-timeline": ["target"],
    "liturgical-day": ["readings", "activePropers"],
    "ordo": ["sections"],
    "proper": ["ordos"],
    "reading": ["role"],
    "role": ["inherits"],
    "role-group": ["roles"],
    "rubric": ["actors"],
    "section": ["blocks"],
    "service-instance": ["ordo", "activePropers"],
    "teaching-note": ["target"],
    "utterance": ["roles"],
}
"""Entity fields whose values are IDs of other entities expected to resolve like ``$ref``."""


def _entity_type(entity: dict[str, Any]) -> str:
    declared = entity["value"].get("type")
    if isinstance(declared, str) and declared in ID_REFERENCE_FIELDS:
        return declared
    key = entity["pointer"].rsplit("/", 1)[-1]
    return key if key in ID_REFERENCE_FIELDS else str(declared or "")


def _reference_sites(entities: list[dict[str, Any]], refs: list[dict[str, Any]]) -> list[dict[str, str]]:
    """Every place a package refers to another entity: ``$ref`` objects and ID-valued fields."""
    sites = [
        {"value": ref["value"]["$ref"], "source": ref["source"], "pointer": ref["pointer"] + "/$ref"} for ref in refs
    ]
    for entity in entities:
        for field in ID_REFERENCE_FIELDS.get(_entity_type(entity), []):
            value = entity["value"].get(field)
            if isinstance(value, str):
                sites.append({"value": value, "source": entity["source"], "pointer": f"{entity['pointer']}/{field}"})
            elif isinstance(value, list):
                for i, item in enumerate(value):
                    if isinstance(item, str):
                        sites.append(
                            {"value": item, "source": entity["source"], "pointer": f"{entity['pointer']}/{field}/{i}"}
                        )
    return sites


def validate_package(root: Union[str, Path], registry: Optional[SchemaRegistry] = None) -> ValidationReport:
    directory = Path(root).resolve()
    schemas = registry or SchemaRegistry.bundled()
    documents = load_package(directory)
    diagnostics: list[Diagnostic] = []
    versions: list[str] = []
    entities: list[dict[str, Any]] = []
    refs: list[dict[str, Any]] = []
    for document in documents:
        result = validate_document(document, schemas)
        diagnostics.extend(result.diagnostics)
        versions.extend(result.schemaVersions)
        child_entities, child_refs = _walk(document.raw, document.source)
        entities.extend(child_entities)
        refs.extend(child_refs)
    index: dict[str, dict[str, Any]] = {}
    for entity in entities:
        identifier = entity["value"]["id"]
        if identifier in index:
            diagnostics.append(
                Diagnostic(
                    layer="references",
                    source=entity["source"],
                    entityId=identifier,
                    jsonPointer=entity["pointer"] + "/id",
                    code="OLS_ID_DUPLICATE",
                    message=f"Duplicate ID {identifier}.",
                    severity="error",
                )
            )
        else:
            entity["value"]["__source"] = entity["source"]
            index[identifier] = entity["value"]

        if any(c.isupper() for c in identifier):
            diagnostics.append(
                Diagnostic(
                    layer="consistency",
                    source=entity["source"],
                    entityId=identifier,
                    jsonPointer=entity["pointer"] + "/id",
                    code="OLS_ID_UPPERCASE",
                    message="IDs should be lowercase for compatibility and consistency.",
                    severity="warning",
                )
            )
    manifest = next(
        (doc.raw for doc in documents if isinstance(doc.raw, dict) and doc.raw.get("type") == "manifest"), None
    )
    package_name = str(manifest.get("package", "")) if isinstance(manifest, dict) else None
    dependencies = manifest.get("dependencies", []) if isinstance(manifest, dict) else []

    def is_declared_dependency(name: str) -> bool:
        return any(item.split("@", 1)[0] == name for item in dependencies)

    sites = _reference_sites(entities, refs)
    for reference in sites:
        target = reference["value"]
        if resolve_reference(target, index, directory, reference["source"], package_name) is not None:
            continue
        qualified = package_qualifier(target)
        if isinstance(manifest, dict) and qualified is not None and qualified[0] != package_name:
            # Undeclared packages are reported as OLS_DEPENDENCY_UNDECLARED below.
            if is_declared_dependency(qualified[0]):
                diagnostics.append(
                    Diagnostic(
                        layer="references",
                        source=reference["source"],
                        jsonPointer=reference["pointer"],
                        code="OLS_REF_EXTERNAL",
                        message=f"Reference {target} targets dependency {qualified[0]} and was not resolved locally.",
                        severity="info",
                    )
                )
            continue
        diagnostics.append(
            Diagnostic(
                layer="references",
                source=reference["source"],
                jsonPointer=reference["pointer"],
                code="OLS_REF_PATH_ESCAPE" if ".." in target else "OLS_REF_UNRESOLVED",
                message=f"Reference {target} could not be resolved.",
                severity="error",
            )
        )
    ordos = {item["value"]["id"]: item["value"] for item in entities if item["value"].get("type") == "ordo"}
    for proper in (item for item in entities if item["value"].get("type") == "proper"):
        for ordo_id in proper["value"].get("ordos", []):
            if ordo_id not in ordos:
                continue
            slots = set(ordos[ordo_id].get("properSlots", []))
            for slot in proper["value"].get("fills", {}):
                if slot not in slots:
                    diagnostics.append(
                        Diagnostic(
                            layer="semantic",
                            source=proper["source"],
                            entityId=proper["value"]["id"],
                            jsonPointer=proper["pointer"] + "/fills/" + slot,
                            code="OLS_PROPER_SLOT_UNKNOWN",
                            message=f"Ordo {ordo_id} does not declare slot {slot}.",
                            severity="error",
                        )
                    )
    if not any(isinstance(doc.raw, dict) and doc.raw.get("type") == "manifest" for doc in documents):
        diagnostics.append(
            Diagnostic(
                layer="consistency",
                source=(directory / "manifest.ols.json").as_posix(),
                code="OLS_MANIFEST_MISSING",
                message="Package is missing manifest.ols.json.",
                severity="error",
            )
        )
    if isinstance(manifest, dict):
        for reference in sites:
            target = reference["value"]
            qualified = package_qualifier(target)
            if qualified is not None and target not in index:
                dependency = qualified[0]
                if dependency != package_name and not is_declared_dependency(dependency):
                    diagnostics.append(
                        Diagnostic(
                            layer="references",
                            source=reference["source"],
                            jsonPointer=reference["pointer"],
                            code="OLS_DEPENDENCY_UNDECLARED",
                            message=f"Reference uses undeclared dependency {dependency}.",
                            severity="error",
                        )
                    )
        package_authority = manifest.get("authority", {})
        package_allowed = set(package_authority.get("allowedUse", []))
        package_restricted = set(package_authority.get("restrictedUse", []))
        package_license = manifest.get("license") if isinstance(manifest.get("license"), str) else None
        allowed_licenses = set(manifest.get("allowedLicenseOverrides", []))

        manifest_source = (directory / "manifest.ols.json").as_posix()
        manifest_files = manifest.get("files", [])
        absolute_manifest_files = {
            (directory / f).resolve().as_posix() for f in manifest_files
        }

        for idx, f in enumerate(manifest_files):
            abs_path = (directory / f).resolve().as_posix()
            if not any(doc.source == abs_path for doc in documents):
                diagnostics.append(
                    Diagnostic(
                        layer="consistency",
                        source=manifest_source,
                        jsonPointer=f"/files/{idx}",
                        code="OLS_MANIFEST_FILE_NOT_FOUND",
                        message=f"Declared file {f} does not exist in the package.",
                        severity="error",
                    )
                )

        for doc in documents:
            if doc.source == manifest_source:
                continue
            if doc.source not in absolute_manifest_files:
                diagnostics.append(
                    Diagnostic(
                        layer="consistency",
                        source=doc.source,
                        jsonPointer="",
                        code="OLS_MANIFEST_FILE_UNDECLARED",
                        message="File is not declared in the manifest.ols.json files list.",
                        severity="error",
                    )
                )
        for entity in entities:
            authority = entity["value"].get("authority", {})
            allowed = authority.get("allowedUse")
            restricted = authority.get("restrictedUse")
            if package_allowed and allowed and any(use not in package_allowed for use in allowed):
                diagnostics.append(
                    Diagnostic(
                        layer="semantic",
                        source=entity["source"],
                        entityId=entity["value"]["id"],
                        jsonPointer=entity["pointer"] + "/authority/allowedUse",
                        code="OLS_AUTHORITY_BROADENED",
                        message="Entity allowedUse broadens the package authority.",
                        severity="error",
                    )
                )
            if package_restricted and restricted and any(use not in restricted for use in package_restricted):
                diagnostics.append(
                    Diagnostic(
                        layer="semantic",
                        source=entity["source"],
                        entityId=entity["value"]["id"],
                        jsonPointer=entity["pointer"] + "/authority/restrictedUse",
                        code="OLS_AUTHORITY_BROADENED",
                        message="Entity restrictedUse removes a package restriction.",
                        severity="error",
                    )
                )
            license_value = entity["value"].get("license")
            if (
                package_license
                and isinstance(license_value, str)
                and license_value != package_license
                and license_value not in allowed_licenses
            ):
                diagnostics.append(
                    Diagnostic(
                        layer="semantic",
                        source=entity["source"],
                        entityId=entity["value"]["id"],
                        jsonPointer=entity["pointer"] + "/license",
                        code="OLS_LICENSE_BROADENED",
                        message=f"License override {license_value} is not permitted by the manifest.",
                        severity="error",
                    )
                )
    graph = {
        item["value"]["id"]: [
            resolved["id"]
            for resolved in (
                resolve_reference(target, index, directory, item["source"], package_name)
                for target in [ref["value"]["$ref"] for ref in _walk(item["value"], item["source"])[1]]
                + [site["value"] for site in _reference_sites([item], [])]
            )
            if resolved is not None
        ]
        for item in entities
    }
    visiting: set[str] = set()
    visited: set[str] = set()

    def visit(identifier: str) -> None:
        if identifier in visiting:
            item = next(entity for entity in entities if entity["value"]["id"] == identifier)
            diagnostics.append(
                Diagnostic(
                    layer="references",
                    source=item["source"],
                    entityId=identifier,
                    jsonPointer=item["pointer"],
                    code="OLS_REF_CYCLE",
                    message=f"Reference cycle includes {identifier}.",
                    severity="error",
                )
            )
            return
        if identifier in visited:
            return
        visiting.add(identifier)
        for target in graph.get(identifier, []):
            visit(target)
        visiting.remove(identifier)
        visited.add(identifier)

    for identifier in graph:
        visit(identifier)
    state_keys = {
        key
        for item in entities
        if item["value"].get("type") == "rubric"
        for key in item["value"].get("stateTransition", {}).get("sets", {})
    }
    for item in (entity for entity in entities if entity["value"].get("type") == "rubric"):
        for key in item["value"].get("stateTransition", {}).get("requires", {}):
            if key not in state_keys:
                diagnostics.append(
                    Diagnostic(
                        layer="semantic",
                        source=item["source"],
                        entityId=item["value"]["id"],
                        jsonPointer=item["pointer"] + "/stateTransition/requires/" + key,
                        code="OLS_RUBRIC_STATE_UNREACHABLE",
                        message=f"No rubric establishes required state {key}.",
                        severity="error",
                    )
                )
    propers = [item for item in entities if item["value"].get("type") == "proper"]
    for proper in propers:
        for mutation in proper["value"].get("mutations", []):
            if isinstance(mutation.get("target"), str) and mutation["target"] not in index:
                diagnostics.append(
                    Diagnostic(
                        layer="semantic",
                        source=proper["source"],
                        entityId=proper["value"]["id"],
                        jsonPointer=proper["pointer"],
                        code="OLS_MUTATION_TARGET_UNRESOLVED",
                        message=f"Mutation target {mutation['target']} does not resolve.",
                        severity="error",
                    )
                )
    for left, first in enumerate(propers):
        for second in propers[left + 1 :]:
            a = first["value"]
            b = second["value"]
            if (
                set(a.get("fills", {})) & set(b.get("fills", {}))
                and a.get("priority") == b.get("priority")
                and a.get("priorityClass") == b.get("priorityClass")
            ):
                diagnostics.append(
                    Diagnostic(
                        layer="semantic",
                        source=second["source"],
                        entityId=b["id"],
                        jsonPointer=second["pointer"],
                        code="OLS_CALENDAR_DETERMINISM_UNPROVEN",
                        message=f"Proper {a['id']} ties with {b['id']}; an explicit conflict rule or fixture is required.",
                        severity="warning",
                    )
                )
    return _report(diagnostics, [document.source for document in documents], versions)


def validate_translation_variants(data: dict[str, Any], source: str = "<inline>") -> list[Diagnostic]:
    """Validate translation variants in a data structure. Public API wrapper."""
    return _validate_translation_variants(data, source)


def run_self_tests(root: Union[str, Path]) -> ValidationReport:
    diagnostics: list[Diagnostic] = []
    directory = Path(root).resolve()
    for expected_valid, name in ((True, "valid"), (False, "invalid")):
        folder = directory / "tests" / name
        if not folder.exists():
            continue
        for source in sorted(path for path in folder.glob("*.json") if not path.name.endswith(".expected.json")):
            result = validate_document(source)
            passed = result.valid == expected_valid
            if not expected_valid:
                expectation_path = source.with_name(source.name.replace(".json", ".expected.json"))
                if not expectation_path.exists():
                    passed = False
                else:
                    expectation = json.loads(expectation_path.read_text())
                    passed = passed and any(
                        item.layer == expectation["layer"] and item.code == expectation["code"]
                        for item in result.diagnostics
                    )
            if not passed:
                diagnostics.append(
                    Diagnostic(
                        layer="semantic",
                        source=source.as_posix(),
                        code="OLS_SELF_TEST_FAILED",
                        message=f"Fixture did not produce the expected {name} result.",
                        severity="error",
                    )
                )
    return _report(diagnostics, [], ["1.0.0"])
