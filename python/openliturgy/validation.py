from __future__ import annotations

import json
import re
from collections.abc import Callable, Iterable
from pathlib import Path
from typing import Any
from urllib.parse import unquote

from .integrity import (
    bytes_digest,
    canonical_digest,
    is_package_relative_uri,
    manifest_file_entries,
    package_digest,
)
from .loading import DEFAULT_PACKAGES_DIRECTORY, LoadedDocument, load_document, load_package
from .models import Diagnostic, Layer, Severity, ValidationReport
from .references import package_qualifier, resolve_reference
from .schemas import SchemaRegistry
from .trust import (
    ATTESTED_STATUSES,
    approval_signature_message,
    package_signature_message,
    sign_message,
    trusted_key,
    verify_signature,
)

LAYERS: list[Layer] = ["parse", "schema-selection", "structural", "consistency", "references", "semantic"]


def _report(
    diagnostics: list[Diagnostic], files: Iterable[str], versions: Iterable[str], skipped: list[Layer] | None = None
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
    value: str | Path | LoadedDocument, registry: SchemaRegistry | None = None
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


LOCKFILE_NAME = "ols.lock.json"
DependencyResolver = Callable[[str, dict[str, Any], Path], Path | None]
"""Returns the directory of a locked dependency, or ``None`` when it cannot be found."""


def filesystem_resolver(name: str, entry: dict[str, Any], root: Path) -> Path | None:
    """Resolve ``lock.packages[name].resolved`` as a directory relative to the package root."""
    resolved = entry.get("resolved")
    if not isinstance(resolved, str) or not is_package_relative_uri(resolved):
        return None
    directory = (root / resolved).resolve()
    return directory if (directory / "manifest.ols.json").is_file() else None


def parse_dependency(spec: str) -> tuple[str, str | None]:
    """Split a manifest dependency (``name`` or ``name@range``)."""
    name, at, version_range = spec.partition("@")
    return name, (version_range if at else None)


def version_satisfies(version: str, version_range: str | None) -> bool:
    """A range is a version prefix: ``1`` matches 1.x.y, ``1.2`` matches 1.2.y, ``1.2.3`` matches exactly."""
    if not version_range:
        return True
    have = version.split(".")
    return all(i < len(have) and have[i] == part for i, part in enumerate(version_range.split(".")))


def _pointer_token(value: str) -> str:
    return value.replace("~", "~0").replace("/", "~1")


def _string_record(value: Any) -> dict[str, str]:
    if not isinstance(value, dict):
        return {}
    return {key: item for key, item in value.items() if isinstance(item, str)}


def _load_dependencies(
    root: Path,
    manifest: dict[str, Any],
    documents: list[LoadedDocument],
    resolver: DependencyResolver,
    diagnostics: list[Diagnostic],
) -> dict[str, dict[str, Any]]:
    """Load every dependency pinned in ``ols.lock.json`` and check it against the lock. Mirrors ``loadDependencies``."""
    loaded: dict[str, dict[str, Any]] = {}
    lock_source = (root / LOCKFILE_NAME).as_posix()
    lock_document = next((doc for doc in documents if doc.source == lock_source), None)
    if lock_document is None or lock_document.data is None:
        return loaded
    lock = _parsed(lock_document)
    locked = lock.get("packages") if isinstance(lock.get("packages"), dict) else {}
    specs = [item for item in manifest.get("dependencies", []) if isinstance(item, str)] if isinstance(
        manifest.get("dependencies"), list
    ) else []
    declared = [parse_dependency(spec) for spec in specs]

    def push(pointer: str, code: str, message: str, severity: Severity = "error") -> None:
        diagnostics.append(
            Diagnostic(
                layer="references", source=lock_source, jsonPointer=pointer, code=code, message=message, severity=severity
            )
        )

    for name, version_range in declared:
        base = f"/packages/{_pointer_token(name)}"
        entry = locked.get(name)
        if not isinstance(entry, dict):
            push("/packages", "OLS_DEPENDENCY_UNLOCKED", f"Dependency {name} is declared but not locked; run `ols lock`.")
            continue
        if not version_satisfies(str(entry.get("version")), version_range):
            push(
                f"{base}/version",
                "OLS_DEPENDENCY_VERSION_MISMATCH",
                f"Locked version {entry.get('version')} does not satisfy {name}@{version_range}.",
            )
        directory = resolver(name, entry, root) if isinstance(entry.get("resolved"), str) else None
        if directory is None:
            push(
                f"{base}/resolved",
                "OLS_DEPENDENCY_NOT_FOUND",
                f"Dependency {name} could not be found at {entry.get('resolved')}.",
            )
            continue
        directory = Path(directory).resolve()
        dependency_documents = load_package(directory)
        manifest_source = (directory / "manifest.ols.json").as_posix()
        dependency_manifest_document = next((doc for doc in dependency_documents if doc.source == manifest_source), None)
        dependency_manifest = (
            _parsed(dependency_manifest_document)
            if dependency_manifest_document is not None and isinstance(dependency_manifest_document.raw, dict)
            else None
        )
        if not isinstance(dependency_manifest, dict) or dependency_manifest.get("package") != name:
            push(base, "OLS_DEPENDENCY_MISMATCH", f"The package at {entry.get('resolved')} is not {name}.")
            continue
        if dependency_manifest.get("version") != entry.get("version"):
            push(
                f"{base}/version",
                "OLS_DEPENDENCY_VERSION_MISMATCH",
                f"Resolved {name} is version {dependency_manifest.get('version')}, but the lock records "
                f"{entry.get('version')}.",
            )
        actual = package_digest(dependency_manifest)
        if actual != entry.get("digest"):
            push(
                f"{base}/digest",
                "OLS_DEPENDENCY_DIGEST_MISMATCH",
                f"Resolved {name} has package digest {actual}, but the lock records {entry.get('digest')}.",
            )
        entities: list[dict[str, Any]] = []
        for document in dependency_documents:
            if isinstance(document.raw, dict):
                entities.extend(_walk(_parsed(document), document.source)[0])
        problems = [
            item
            for item in _integrity_diagnostics(directory, dependency_documents, entities, strict=True)
            if item.severity == "error"
        ]
        if problems:
            codes = ", ".join(sorted({item.code for item in problems}))
            push(base, "OLS_DEPENDENCY_INTEGRITY", f"Dependency {name} failed verification: {codes}.")
        ids: set[str] = set()
        for entity in entities:
            ids.add(str(entity["value"]["id"]))
        loaded[name] = {
            "version": str(dependency_manifest.get("version")),
            "ids": ids,
            "aliases": _string_record(dependency_manifest.get("aliases")),
        }
    declared_names = {name for name, _ in declared}
    for name in sorted(locked, key=lambda item: item.encode("utf-16-be")):
        if name not in declared_names:
            push(
                f"/packages/{_pointer_token(name)}",
                "OLS_LOCK_ENTRY_UNUSED",
                f"Lock entry {name} is not a declared dependency.",
                "warning",
            )
    return loaded


def validate_package(
    root: Union[str, Path],
    registry: Optional[SchemaRegistry] = None,
    resolver: Optional[DependencyResolver] = None,
    keyring: Optional[dict[str, Any]] = None,
) -> ValidationReport:
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

    dependency_packages = (
        _load_dependencies(directory, manifest, documents, resolver or filesystem_resolver, diagnostics)
        if isinstance(manifest, dict)
        else {}
    )
    aliases = _string_record(manifest.get("aliases")) if isinstance(manifest, dict) else {}
    manifest_path = (directory / "manifest.ols.json").as_posix()
    for former, current in aliases.items():
        if former in index:
            diagnostics.append(
                Diagnostic(
                    layer="references",
                    source=manifest_path,
                    jsonPointer=f"/aliases/{_pointer_token(former)}",
                    code="OLS_ALIAS_SHADOWED",
                    message=f"Alias {former} is also the ID of an entity, so the alias never applies.",
                    severity="error",
                )
            )
        if current not in index:
            diagnostics.append(
                Diagnostic(
                    layer="references",
                    source=manifest_path,
                    jsonPointer=f"/aliases/{_pointer_token(former)}",
                    code="OLS_ALIAS_TARGET_UNRESOLVED",
                    message=f"Alias {former} points to {current}, which does not exist.",
                    severity="error",
                )
            )

    def renamed(site: dict[str, str], former: str, current: str) -> None:
        diagnostics.append(
            Diagnostic(
                layer="references",
                source=site["source"],
                jsonPointer=site["pointer"],
                code="OLS_ID_RENAMED",
                message=f"{former} was renamed; reference {current} instead.",
                severity="warning",
            )
        )

    sites = _reference_sites(entities, refs)
    for reference in sites:
        target = reference["value"]
        if resolve_reference(target, index, directory, reference["source"], package_name) is not None:
            continue
        qualified = package_qualifier(target)
        local_id = (qualified[1] if qualified[0] == package_name else None) if qualified is not None else target
        if local_id is not None and local_id in aliases and aliases[local_id] in index:
            renamed(reference, target, aliases[local_id])
            continue
        if isinstance(manifest, dict) and qualified is not None and qualified[0] != package_name:
            dependency_package = dependency_packages.get(qualified[0])
            if dependency_package is not None:
                if qualified[1] in dependency_package["ids"]:
                    continue
                alias_target = dependency_package["aliases"].get(qualified[1])
                if alias_target is not None and alias_target in dependency_package["ids"]:
                    renamed(reference, target, f"{qualified[0]}:{alias_target}")
                    continue
                diagnostics.append(
                    Diagnostic(
                        layer="references",
                        source=reference["source"],
                        jsonPointer=reference["pointer"],
                        code="OLS_REF_UNRESOLVED",
                        message=f"{qualified[1]} is not defined by dependency {qualified[0]}@{dependency_package['version']}.",
                        severity="error",
                    )
                )
                continue
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
        manifest_files = manifest_file_entries(manifest.get("files"))
        absolute_manifest_files = {(directory / entry["path"]).resolve().as_posix() for entry in manifest_files}

        for idx, entry in enumerate(manifest_files):
            abs_path = (directory / entry["path"]).resolve().as_posix()
            if not any(doc.source == abs_path for doc in documents):
                diagnostics.append(
                    Diagnostic(
                        layer="consistency",
                        source=manifest_source,
                        jsonPointer=f"/files/{idx}",
                        code="OLS_MANIFEST_FILE_NOT_FOUND",
                        message=f"Declared file {entry['path']} does not exist in the package.",
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
    diagnostics.extend(_integrity_diagnostics(directory, documents, entities, strict=False))
    diagnostics.extend(_trust_diagnostics(directory, documents, keyring, strict=False))
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


def _parsed(document: LoadedDocument) -> Any:
    """Fresh parse of a document: validation annotates parsed entities in place, which must not affect digests."""
    return json.loads(document.raw_text)


def _integrity_diagnostics(
    directory: Path, documents: list[LoadedDocument], entities: list[dict[str, Any]], strict: bool
) -> list[Diagnostic]:
    """Integrity checks shared by ``validate_package`` (declared digests) and ``verify_package`` (all pinned)."""
    diagnostics: list[Diagnostic] = []
    manifest_source = (directory / "manifest.ols.json").as_posix()
    manifest_document = next((doc for doc in documents if doc.source == manifest_source), None)
    if manifest_document is None or not isinstance(manifest_document.raw, dict):
        return diagnostics
    manifest = _parsed(manifest_document)
    pinned: set[str] = set()
    for idx, entry in enumerate(manifest_file_entries(manifest.get("files"))):
        source = (directory / entry["path"]).resolve().as_posix()
        document = next((doc for doc in documents if doc.source == source), None)
        if not entry.get("digest") or document is None or document.raw is None:
            continue
        pinned.add(source)
        actual = canonical_digest(_parsed(document))
        if actual != entry["digest"]:
            diagnostics.append(
                Diagnostic(
                    layer="consistency",
                    source=manifest_source,
                    jsonPointer=f"/files/{idx}/digest",
                    code="OLS_FILE_DIGEST_MISMATCH",
                    message=f"{entry['path']} has digest {actual}, but the manifest declares {entry['digest']}.",
                    severity="error",
                )
            )
    if isinstance(manifest.get("digest"), str):
        actual = package_digest(manifest)
        if actual != manifest["digest"]:
            diagnostics.append(
                Diagnostic(
                    layer="consistency",
                    source=manifest_source,
                    jsonPointer="/digest",
                    code="OLS_PACKAGE_DIGEST_MISMATCH",
                    message=f"The package digest is {actual}, but the manifest declares {manifest['digest']}.",
                    severity="error",
                )
            )
    elif strict:
        diagnostics.append(
            Diagnostic(
                layer="consistency",
                source=manifest_source,
                jsonPointer="",
                code="OLS_PACKAGE_DIGEST_MISSING",
                message="The manifest does not declare a package digest; run `ols pack`.",
                severity="error",
            )
        )
    if strict:
        for document in documents:
            if document.source == manifest_source or document.source in pinned:
                continue
            diagnostics.append(
                Diagnostic(
                    layer="consistency",
                    source=document.source,
                    jsonPointer="",
                    code="OLS_FILE_UNPINNED",
                    message="The manifest does not declare a digest for this file; run `ols pack`.",
                    severity="error",
                )
            )
    for entity in entities:
        value = entity["value"]
        uri = value.get("uri")
        if value.get("type") != "asset" or not isinstance(uri, str) or not is_package_relative_uri(uri):
            continue
        entity_id = str(value.get("id"))
        target = (directory / unquote(re.split(r"[?#]", uri, maxsplit=1)[0])).resolve()
        try:
            target.relative_to(directory)
        except ValueError:
            diagnostics.append(
                Diagnostic(
                    layer="references",
                    source=entity["source"],
                    entityId=entity_id,
                    jsonPointer=entity["pointer"] + "/uri",
                    code="OLS_REF_PATH_ESCAPE",
                    message=f"Asset URI {uri} resolves outside the package root.",
                    severity="error",
                )
            )
            continue
        if not target.is_file():
            diagnostics.append(
                Diagnostic(
                    layer="references",
                    source=entity["source"],
                    entityId=entity_id,
                    jsonPointer=entity["pointer"] + "/uri",
                    code="OLS_ASSET_NOT_FOUND",
                    message=f"Asset file {uri} is not in the package.",
                    severity="warning",
                )
            )
            continue
        data = target.read_bytes()
        byte_size = value.get("byteSize")
        if isinstance(byte_size, int) and not isinstance(byte_size, bool) and byte_size != len(data):
            diagnostics.append(
                Diagnostic(
                    layer="consistency",
                    source=entity["source"],
                    entityId=entity_id,
                    jsonPointer=entity["pointer"] + "/byteSize",
                    code="OLS_ASSET_SIZE_MISMATCH",
                    message=f"Asset file is {len(data)} bytes, but byteSize declares {byte_size}.",
                    severity="error",
                )
            )
        if isinstance(value.get("digest"), str):
            actual = bytes_digest(data)
            if actual != value["digest"]:
                diagnostics.append(
                    Diagnostic(
                        layer="consistency",
                        source=entity["source"],
                        entityId=entity_id,
                        jsonPointer=entity["pointer"] + "/digest",
                        code="OLS_ASSET_DIGEST_MISMATCH",
                        message=f"Asset file has digest {actual}, but the record declares {value['digest']}.",
                        severity="error",
                    )
                )
        elif strict:
            diagnostics.append(
                Diagnostic(
                    layer="consistency",
                    source=entity["source"],
                    entityId=entity_id,
                    jsonPointer=entity["pointer"],
                    code="OLS_ASSET_UNPINNED",
                    message="Package-local asset has no digest.",
                    severity="error",
                )
            )
    return diagnostics


def _signatures(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def _trust_diagnostics(
    directory: Path, documents: list[LoadedDocument], keyring: Optional[dict[str, Any]], strict: bool
) -> list[Diagnostic]:
    """Signature and approval checks shared by ``validate_package`` and ``verify_package``. Mirrors ``trustDiagnostics``."""
    diagnostics: list[Diagnostic] = []
    manifest_source = (directory / "manifest.ols.json").as_posix()
    manifest_document = next((doc for doc in documents if doc.source == manifest_source), None)
    if manifest_document is not None and isinstance(manifest_document.raw, dict):
        manifest = _parsed(manifest_document)
        message = package_signature_message(package_digest(manifest))
        trusted = False
        for i, entry in enumerate(_signatures(manifest.get("signatures"))):
            if not verify_signature(message, entry):
                diagnostics.append(
                    Diagnostic(
                        layer="semantic",
                        source=manifest_source,
                        jsonPointer=f"/signatures/{i}",
                        code="OLS_SIGNATURE_INVALID",
                        message="Package signature does not match the package content or key.",
                        severity="error",
                    )
                )
            elif keyring is not None and trusted_key(keyring, entry["key"]) is None:
                diagnostics.append(
                    Diagnostic(
                        layer="semantic",
                        source=manifest_source,
                        jsonPointer=f"/signatures/{i}",
                        code="OLS_SIGNATURE_UNTRUSTED",
                        message=f"Package is signed by {entry['key']}, which is not in the keyring.",
                        severity="info",
                    )
                )
            elif keyring is not None:
                trusted = True
        if strict and keyring is not None and not trusted:
            diagnostics.append(
                Diagnostic(
                    layer="semantic",
                    source=manifest_source,
                    jsonPointer="",
                    code="OLS_PACKAGE_UNSIGNED",
                    message="The package has no valid signature from a trusted key.",
                    severity="error",
                )
            )
    entities: list[dict[str, Any]] = []
    for document in documents:
        if isinstance(document.raw, dict):
            entities.extend(_walk(_parsed(document), document.source)[0])
    index: dict[str, dict[str, Any]] = {}
    for entity in entities:
        index.setdefault(str(entity["value"]["id"]), entity)
    covered: list[tuple[str, dict[str, Any]]] = []
    for document in documents:
        if not isinstance(document.raw, dict) or document.raw.get("type") != "approval" or document.data is None:
            continue
        approval = _parsed(document)
        status = str(approval.get("status"))
        approval_id = str(approval.get("id"))
        attested = keyring is None
        message = approval_signature_message(approval)
        for i, entry in enumerate(_signatures(approval.get("signatures"))):
            if not verify_signature(message, entry):
                diagnostics.append(
                    Diagnostic(
                        layer="semantic",
                        source=document.source,
                        entityId=approval_id,
                        jsonPointer=f"/signatures/{i}",
                        code="OLS_SIGNATURE_INVALID",
                        message="Approval signature does not match the approval or key.",
                        severity="error",
                    )
                )
                continue
            if keyring is None:
                continue
            key = trusted_key(keyring, entry["key"])
            approves = key.get("approves") if key is not None else None
            if key is not None and (approves is None or status in approves):
                attested = True
            else:
                diagnostics.append(
                    Diagnostic(
                        layer="semantic",
                        source=document.source,
                        entityId=approval_id,
                        jsonPointer=f"/signatures/{i}",
                        code="OLS_SIGNATURE_UNTRUSTED",
                        message=(
                            f"Key {entry['key']} is trusted, but not to attest {status}."
                            if key is not None
                            else f"Approval is signed by {entry['key']}, which is not in the keyring."
                        ),
                        severity="info",
                    )
                )
        if not attested:
            diagnostics.append(
                Diagnostic(
                    layer="semantic",
                    source=document.source,
                    entityId=approval_id,
                    jsonPointer="",
                    code="OLS_APPROVAL_UNTRUSTED",
                    message=f"Approval {approval_id} has no valid signature from a key trusted to attest {status}.",
                    severity="error" if strict else "warning",
                )
            )
        subjects = approval.get("subjects") if isinstance(approval.get("subjects"), list) else []
        for i, subject in enumerate(subjects):
            subject_entity = index.get(str(subject.get("entity"))) if isinstance(subject, dict) else None
            if subject_entity is None:
                diagnostics.append(
                    Diagnostic(
                        layer="semantic",
                        source=document.source,
                        entityId=approval_id,
                        jsonPointer=f"/subjects/{i}/entity",
                        code="OLS_APPROVAL_SUBJECT_UNRESOLVED",
                        message=f"Approved entity {subject.get('entity') if isinstance(subject, dict) else subject} is not in the package.",
                        severity="error",
                    )
                )
                continue
            actual = canonical_digest(subject_entity["value"])
            if actual != subject.get("digest"):
                diagnostics.append(
                    Diagnostic(
                        layer="semantic",
                        source=document.source,
                        entityId=approval_id,
                        jsonPointer=f"/subjects/{i}/digest",
                        code="OLS_APPROVAL_STALE",
                        message=(
                            f"{subject.get('entity')} changed after it was approved (now {actual}); "
                            "the approval no longer applies to it."
                        ),
                        severity="error",
                    )
                )
                continue
            if attested:
                covered.append((status, subject_entity))
    for entity in entities:
        authority = entity["value"].get("authority")
        claimed = authority.get("status") if isinstance(authority, dict) else None
        if not isinstance(claimed, str) or claimed not in ATTESTED_STATUSES:
            continue
        is_covered = any(
            item_status == claimed
            and item["source"] == entity["source"]
            and (entity["pointer"] == item["pointer"] or entity["pointer"].startswith(item["pointer"] + "/"))
            for item_status, item in covered
        )
        if not is_covered:
            entity_id = str(entity["value"].get("id"))
            diagnostics.append(
                Diagnostic(
                    layer="semantic",
                    source=entity["source"],
                    entityId=entity_id,
                    jsonPointer=entity["pointer"] + "/authority/status",
                    code="OLS_AUTHORITY_UNATTESTED",
                    message=f"{entity_id} claims {claimed}, but no approval in effect covers its current content.",
                    severity="warning",
                )
            )
    return diagnostics


def sign_package(root: Union[str, Path], private_key_pem: str, signer: Optional[str] = None) -> dict[str, str]:
    """Sign a packed package: add (or replace) this key's signature over the package digest. Mirrors ``signPackage``."""
    directory = Path(root).resolve()
    manifest_path = directory / "manifest.ols.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    verification = verify_package(directory)
    if not isinstance(manifest.get("digest"), str) or not verification.valid:
        codes = ", ".join(dict.fromkeys(item.code for item in verification.diagnostics))
        raise ValueError(f"Run `ols pack` before signing; the package does not verify ({codes}).")
    entry = sign_message(package_signature_message(manifest["digest"]), private_key_pem)
    if signer:
        entry["signer"] = signer
    manifest["signatures"] = [
        item for item in _signatures(manifest.get("signatures")) if not (isinstance(item, dict) and item.get("key") == entry["key"])
    ] + [entry]
    manifest_path.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return entry


def sign_approval(path: Union[str, Path], private_key_pem: str, signer: Optional[str] = None) -> dict[str, str]:
    """Sign an approval document in place. Mirrors ``signApproval``; re-run ``ols pack`` afterwards."""
    file = Path(path)
    approval = json.loads(file.read_text(encoding="utf-8"))
    if approval.get("type") != "approval":
        raise ValueError(f"{path} is not an approval document.")
    entry = sign_message(approval_signature_message(approval), private_key_pem)
    if signer:
        entry["signer"] = signer
    approval["signatures"] = [
        item for item in _signatures(approval.get("signatures")) if not (isinstance(item, dict) and item.get("key") == entry["key"])
    ] + [entry]
    file.write_text(json.dumps(approval, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return entry


def verify_package(root: Union[str, Path], keyring: Optional[dict[str, Any]] = None) -> ValidationReport:
    """Integrity-only verification: every document, package-local asset, and the package itself must be pinned."""
    directory = Path(root).resolve()
    documents = load_package(directory)
    entities: list[dict[str, Any]] = []
    for document in documents:
        if isinstance(document.raw, dict):
            entities.extend(_walk(_parsed(document), document.source)[0])
    diagnostics = _integrity_diagnostics(directory, documents, entities, strict=True)
    diagnostics.extend(_trust_diagnostics(directory, documents, keyring, strict=True))
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
    return _report(diagnostics, [doc.source for doc in documents], [])


def pack_package(root: str | Path, write: bool = True) -> dict[str, Any]:
    """Pin every package document in the manifest and recompute the package digest. Mirrors ``packPackage``."""
    directory = Path(root).resolve()
    manifest_path = directory / "manifest.ols.json"
    documents = load_package(directory)
    manifest_document = next((doc for doc in documents if doc.source == manifest_path.as_posix()), None)
    if manifest_document is None or not isinstance(manifest_document.raw, dict):
        raise ValueError("Package is missing a readable manifest.ols.json.")
    manifest = dict(_parsed(manifest_document))
    previous = {entry["path"]: entry for entry in manifest_file_entries(manifest.get("files"))}
    files: list[dict[str, Any]] = []
    for document in documents:
        if document is manifest_document:
            continue
        if document.raw is None:
            raise ValueError(f"{document.source} is not valid JSON.")
        path = Path(document.source).relative_to(directory).as_posix()
        entry: dict[str, Any] = {"path": path, "digest": canonical_digest(_parsed(document))}
        media_type = previous.get(path, {}).get("mediaType")
        if media_type:
            entry["mediaType"] = media_type
        files.append(entry)
    files.sort(key=lambda entry: entry["path"].encode("utf-16-be"))
    manifest["files"] = files
    previous_digest = manifest.pop("digest", None)
    manifest["digest"] = package_digest(manifest)
    # Signatures cover the previous digest; once the content changes they can only be invalid.
    if previous_digest != manifest["digest"]:
        manifest.pop("signatures", None)
    if write:
        manifest_path.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return manifest


def lock_package(
    root: str | Path, packages_directory: str = DEFAULT_PACKAGES_DIRECTORY, write: bool = True
) -> tuple[dict[str, Any], bool]:
    """Write ``ols.lock.json`` for every declared dependency under ``packages_directory``. Mirrors ``lockPackage``."""
    directory = Path(root).resolve()
    packages_directory = packages_directory.replace("\\", "/")
    manifest_path = directory / "manifest.ols.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    packages: dict[str, dict[str, str]] = {}
    for spec in manifest.get("dependencies", []) if isinstance(manifest.get("dependencies"), list) else []:
        name, version_range = parse_dependency(spec)
        resolved = f"{packages_directory}/{name}"
        dependency_directory = (directory / resolved).resolve()
        try:
            dependency = json.loads((dependency_directory / "manifest.ols.json").read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            raise ValueError(f"Dependency {name} was not found at {resolved}.") from error
        if dependency.get("package") != name:
            raise ValueError(f"The package at {resolved} is {dependency.get('package')}, not {name}.")
        if not version_satisfies(str(dependency.get("version")), version_range):
            raise ValueError(f"{name} {dependency.get('version')} does not satisfy {spec}.")
        verification = verify_package(dependency_directory)
        if not verification.valid:
            codes = ", ".join(dict.fromkeys(item.code for item in verification.diagnostics))
            raise ValueError(f"Dependency {name} does not verify; run `ols pack` in it ({codes}).")
        packages[name] = {"version": str(dependency.get("version")), "digest": str(dependency.get("digest")), "resolved": resolved}
    lock = {
        "$schema": "https://ols.otyg.org/schema/v1.0/lock.schema.json",
        "ols_version": manifest["ols_version"] if isinstance(manifest.get("ols_version"), str) else "1.1.0",
        "type": "lock",
        "packages": dict(sorted(packages.items(), key=lambda item: item[0].encode("utf-16-be"))),
    }
    manifest_updated = False
    if isinstance(manifest.get("files"), list) and not any(
        entry["path"] == LOCKFILE_NAME for entry in manifest_file_entries(manifest["files"])
    ):
        manifest["files"] = [*manifest["files"], LOCKFILE_NAME]
        manifest_updated = True
    if write:
        (directory / LOCKFILE_NAME).write_text(json.dumps(lock, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        if manifest_updated:
            manifest_path.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return lock, manifest_updated


def validate_translation_variants(data: dict[str, Any], source: str = "<inline>") -> list[Diagnostic]:
    """Validate translation variants in a data structure. Public API wrapper."""
    return _validate_translation_variants(data, source)


def run_self_tests(root: str | Path) -> ValidationReport:
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
