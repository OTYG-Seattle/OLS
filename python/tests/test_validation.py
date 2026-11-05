import json
from pathlib import Path

from openliturgy.models import ValidationReport
from openliturgy.references import resolve_reference
from openliturgy.validation import validate_document, validate_package, validate_translation_variants

FIXTURES = Path(__file__).resolve().parents[2] / "fixtures"


def _codes(value: dict) -> list[str]:
    return [item.code for item in validate_translation_variants(value)]


def test_variants_accepts_well_formed_block() -> None:
    codes = _codes({
        "text": {"en": "Lord, have mercy"},
        "variants": {"en": [{"value": "Lord, have mercy", "label": "A", "source": "S", "default": True}]},
    })
    assert codes == []


def test_variants_language_mismatch() -> None:
    codes = _codes({
        "text": {"en": "Lord, have mercy"},
        "variants": {"fr": [{"value": "Seigneur", "label": "F", "source": "S"}]},
    })
    assert "OLS_VARIANT_LANG_MISMATCH" in codes


def test_variants_multiple_defaults() -> None:
    codes = _codes({
        "text": {"en": "Lord, have mercy"},
        "variants": {"en": [
            {"value": "Lord, have mercy", "label": "A", "source": "S", "default": True},
            {"value": "Lord, have mercy", "label": "B", "source": "S", "default": True},
        ]},
    })
    assert "OLS_VARIANT_MULTI_DEFAULT" in codes


def test_variants_default_sync() -> None:
    codes = _codes({
        "text": {"en": "Lord, have mercy"},
        "variants": {"en": [{"value": "O Lord, show mercy", "label": "A", "source": "S", "default": True}]},
    })
    assert "OLS_VARIANT_DEFAULT_SYNC" in codes


def test_malformed_json_is_layer_one(tmp_path: Path) -> None:
    source = tmp_path / "bad.json"
    source.write_text("{", encoding="utf-8")
    result = validate_document(source)
    assert not result.valid
    assert result.diagnostics[0].code == "OLS_JSON_PARSE"


def test_undeclared_and_missing_files_in_manifest(tmp_path: Path) -> None:
    manifest = {
        "$schema": "https://ols.otyg.org/schema/v1.0/manifest.schema.json",
        "ols_version": "1.0.0",
        "type": "manifest",
        "package": "org.openliturgy.test",
        "version": "1.0.1",
        "title": { "en": "Test package" },
        "license": "Apache-2.0",
        "files": ["missing-file.ols.json"]
    }
    (tmp_path / "manifest.ols.json").write_text(json.dumps(manifest), encoding="utf-8")

    extra = {
        "$schema": "https://ols.otyg.org/schema/v1.0/ordo.schema.json",
        "ols_version": "1.0.0",
        "type": "ordo",
        "id": "test-ordo",
        "sections": ["sec-word"]
    }
    (tmp_path / "extra.ols.json").write_text(json.dumps(extra), encoding="utf-8")

    result = validate_package(tmp_path)
    assert not result.valid
    assert any(d.code == "OLS_MANIFEST_FILE_NOT_FOUND" for d in result.diagnostics)
    assert any(d.code == "OLS_MANIFEST_FILE_UNDECLARED" for d in result.diagnostics)


def test_warning_for_uppercase_entity_ids(tmp_path: Path) -> None:
    manifest = {
        "$schema": "https://ols.otyg.org/schema/v1.0/manifest.schema.json",
        "ols_version": "1.0.0",
        "type": "manifest",
        "package": "org.openliturgy.test",
        "version": "1.0.1",
        "title": { "en": "Test package" },
        "license": "Apache-2.0",
        "files": ["ordo.ols.json"]
    }
    (tmp_path / "manifest.ols.json").write_text(json.dumps(manifest), encoding="utf-8")

    ordo = {
        "$schema": "https://ols.otyg.org/schema/v1.0/ordo.schema.json",
        "ols_version": "1.0.0",
        "type": "ordo",
        "id": "TEST-ordo-uppercase",
        "sections": ["sec-word"]
    }
    (tmp_path / "ordo.ols.json").write_text(json.dumps(ordo), encoding="utf-8")

    result = validate_package(tmp_path)
    assert any(d.code == "OLS_ID_UPPERCASE" and d.severity == "warning" for d in result.diagnostics)


def test_package_with_doc_style_mutations_is_structurally_valid() -> None:
    result = validate_package(FIXTURES / "cross-package")
    assert not any(d.layer == "structural" for d in result.diagnostics)


def test_package_qualified_references_are_scoped_to_their_package() -> None:
    result = validate_package(FIXTURES / "cross-package")

    def at(slot: str) -> list[str]:
        return [d.code for d in result.diagnostics if d.jsonPointer == f"/propers/0/fills/{slot}/$ref"]

    assert at("own-qualified") == []
    assert at("own-urn") == []
    assert at("dependency") == ["OLS_REF_EXTERNAL"]
    assert at("undeclared") == ["OLS_DEPENDENCY_UNDECLARED"]
    assert at("missing") == ["OLS_REF_UNRESOLVED"]


def test_resolve_reference_does_not_shadow_other_packages() -> None:
    entity = {"id": "block-kyrie"}
    index = {"block-kyrie": entity, "eotc.kidase.block.kyrie": entity}
    assert resolve_reference("org.other:block-kyrie", index, package_name="org.local") is None
    assert resolve_reference("org.local:block-kyrie", index, package_name="org.local") is entity
    assert resolve_reference("urn:ols:org.local:block-kyrie", index, package_name="org.local") is entity
    assert resolve_reference("urn:ols:eotc:kidase:block:kyrie", index) is entity


def test_bcp47_region_and_private_use_tags_under_ols_1_1() -> None:
    result = validate_document(FIXTURES / "complete-minimal/tests/valid/utterance-bcp47-region.ols.json")
    assert result.valid


def _write_package(tmp_path: Path, corpus: dict) -> ValidationReport:
    (tmp_path / "manifest.ols.json").write_text(json.dumps({
        "$schema": "https://ols.otyg.org/schema/v1.0/manifest.schema.json", "ols_version": "1.1.0",
        "type": "manifest", "package": "org.openliturgy.test", "version": "1.0.0", "title": {"en": "Test"},
        "files": ["corpus.ols.json"],
    }), encoding="utf-8")
    (tmp_path / "corpus.ols.json").write_text(json.dumps({
        "$schema": "https://ols.otyg.org/schema/v1.0/corpus.schema.json", "ols_version": "1.1.0",
        "type": "corpus", "id": "c", **corpus,
    }), encoding="utf-8")
    return validate_package(tmp_path)


def test_id_valued_fields_are_reference_checked(tmp_path: Path) -> None:
    result = _write_package(tmp_path, {
        "blocks": [{"type": "block", "kind": "response", "id": "block-a", "elements": [
            {"utterance": {"id": "ut-a", "roles": ["role-ghost"], "mode": "spoken", "text": {"en": "A"}}}]}],
        "sections": [{"type": "section", "id": "sec-a", "label": {"en": "A"}, "blocks": ["block-a", "block-ghost"]}],
    })
    unresolved = [d.jsonPointer for d in result.diagnostics if d.code == "OLS_REF_UNRESOLVED"]
    assert unresolved == ["/blocks/0/elements/0/utterance/roles/0", "/sections/0/blocks/1"]


def test_role_inheritance_cycle(tmp_path: Path) -> None:
    result = _write_package(tmp_path, {"roles": [
        {"type": "role", "id": "role-a", "kind": "deacon", "inherits": ["role-b"]},
        {"type": "role", "id": "role-b", "kind": "deacon", "inherits": ["role-a"]},
    ]})
    assert any(d.code == "OLS_REF_CYCLE" for d in result.diagnostics)
