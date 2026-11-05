import json
import shutil
from pathlib import Path

from openliturgy.changes import ChangeError, apply_at_pointer, apply_changes
from openliturgy.integrity import canonical_digest, canonicalize
from openliturgy.models import ValidationReport
from openliturgy.references import resolve_reference
from openliturgy.schemas import load_context
from openliturgy.trust import approval_signature_message, generate_signing_key, verify_signature
from openliturgy.validation import (
    apply_overlay,
    diff_packages,
    lock_package,
    merge_packages,
    migrate_package,
    pack_package,
    package_documents,
    sign_approval,
    sign_package,
    validate_document,
    validate_package,
    validate_translation_variants,
    verify_package,
    version_satisfies,
)

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


def test_canonicalization_vectors() -> None:
    for vector in json.loads((FIXTURES / "canonical/vectors.json").read_text(encoding="utf-8")):
        assert canonicalize(json.loads(vector["input"])) == vector["canonical"], vector["name"]


def test_digest_ignores_formatting_order_and_normalization() -> None:
    composed = {"text": {"en": "\u00e9glise"}, "id": "x"}
    decomposed = json.loads('{ "id" : "x", "text": { "en": "e\\u0301glise" } }')
    assert canonical_digest(decomposed) == canonical_digest(composed)


def test_verify_pinned_and_tampered_fixtures() -> None:
    assert verify_package(FIXTURES / "integrity").valid
    codes = sorted(d.code for d in verify_package(FIXTURES / "integrity-tampered").diagnostics)
    assert codes == ["OLS_ASSET_DIGEST_MISMATCH", "OLS_ASSET_SIZE_MISMATCH", "OLS_FILE_DIGEST_MISMATCH"]


def test_pack_makes_package_verifiable(tmp_path: Path) -> None:
    package = tmp_path / "pkg"
    shutil.copytree(FIXTURES / "complete-minimal", package)
    assert not verify_package(package).valid
    manifest = pack_package(package)
    assert manifest["digest"].startswith("sha256:")
    assert verify_package(package).valid
    assert validate_package(package).valid


def _reference_codes(result: ValidationReport) -> list[str]:
    return [f"{d.code} {d.jsonPointer}" for d in result.diagnostics if d.layer == "references"]


def test_dependency_and_alias_resolution() -> None:
    assert _reference_codes(validate_package(FIXTURES / "with-dependency")) == [
        "OLS_ID_RENAMED /ordos/0/sections/0",
        "OLS_ID_RENAMED /sections/0/blocks/1",
        "OLS_REF_UNRESOLVED /sections/0/blocks/2",
    ]


def test_changed_dependency_is_reported(tmp_path: Path) -> None:
    package = tmp_path / "pkg"
    shutil.copytree(FIXTURES / "with-dependency", package)
    corpus = package / "ols_packages/org.openliturgy.dep/corpus.ols.json"
    corpus.write_text(corpus.read_text(encoding="utf-8").replace("Lord, have mercy.", "Lord, have mercy!"), encoding="utf-8")
    assert "OLS_DEPENDENCY_INTEGRITY" in [d.code for d in validate_package(package).diagnostics]


def test_unlocked_dependency_is_reported(tmp_path: Path) -> None:
    package = tmp_path / "pkg"
    shutil.copytree(FIXTURES / "with-dependency", package)
    (package / "ols.lock.json").write_text(json.dumps({
        "$schema": "https://ols.otyg.org/schema/v1.0/lock.schema.json", "ols_version": "1.1.0", "type": "lock",
        "packages": {},
    }), encoding="utf-8")
    assert "OLS_DEPENDENCY_UNLOCKED" in [d.code for d in validate_package(package).diagnostics]


def test_custom_resolver() -> None:
    result = validate_package(FIXTURES / "with-dependency", resolver=lambda name, entry, root: None)
    assert "OLS_DEPENDENCY_NOT_FOUND" in [d.code for d in result.diagnostics]


def test_lock_matches_checked_in_lockfile() -> None:
    lock, _ = lock_package(FIXTURES / "with-dependency", write=False)
    assert lock == json.loads((FIXTURES / "with-dependency/ols.lock.json").read_text(encoding="utf-8"))


def test_version_ranges_are_prefixes() -> None:
    assert version_satisfies("1.2.0", "1")
    assert version_satisfies("1.2.0", "1.2")
    assert not version_satisfies("10.0.0", "1")
    assert not version_satisfies("1.3.0", "1.2")


def test_load_context_matches_published_context() -> None:
    published = json.loads(
        (FIXTURES.parent / "packages/schemas/schemas/v1.0/context.jsonld").read_text(encoding="utf-8")
    )
    assert load_context() == published
    assert load_context()["@context"]["id"] == "@id"


def _keyring() -> dict:
    return json.loads((FIXTURES / "keys/demo-keyring.json").read_text(encoding="utf-8"))


def _report_codes(report: ValidationReport) -> list[str]:
    return sorted(d.code for d in report.diagnostics)


def test_signed_fixture_verifies_against_keyring() -> None:
    assert verify_package(FIXTURES / "signed", _keyring()).valid
    assert _report_codes(validate_package(FIXTURES / "signed", keyring=_keyring())) == ["OLS_SCHEMA_PROVISIONAL"]


def test_changed_content_is_rejected_after_repacking() -> None:
    assert _report_codes(verify_package(FIXTURES / "signed-tampered", _keyring())) == [
        "OLS_APPROVAL_STALE", "OLS_AUTHORITY_UNATTESTED", "OLS_PACKAGE_UNSIGNED", "OLS_SIGNATURE_INVALID",
    ]


def test_untrusted_and_unauthorized_keys() -> None:
    other = {"keys": [{"key": generate_signing_key()[1]}]}
    assert _report_codes(verify_package(FIXTURES / "signed", other)) == [
        "OLS_APPROVAL_UNTRUSTED", "OLS_AUTHORITY_UNATTESTED", "OLS_PACKAGE_UNSIGNED",
        "OLS_SIGNATURE_UNTRUSTED", "OLS_SIGNATURE_UNTRUSTED",
    ]
    limited = _keyring()
    limited["keys"][0]["approves"] = ["parish-reviewed"]
    assert _report_codes(verify_package(FIXTURES / "signed", limited)) == [
        "OLS_APPROVAL_UNTRUSTED", "OLS_AUTHORITY_UNATTESTED", "OLS_SIGNATURE_UNTRUSTED",
    ]


def test_sign_end_to_end(tmp_path: Path) -> None:
    package = tmp_path / "pkg"
    shutil.copytree(FIXTURES / "signed", package)
    private_key_pem, public_key = generate_signing_key()
    sign_approval(package / "approvals/diocesan-review.ols.json", private_key_pem)
    pack_package(package)
    sign_package(package, private_key_pem)
    assert verify_package(package, {"keys": [{"key": public_key}]}).valid


def test_refuses_to_sign_unpacked_package(tmp_path: Path) -> None:
    package = tmp_path / "pkg"
    shutil.copytree(FIXTURES / "complete-minimal", package)
    try:
        sign_package(package, generate_signing_key()[0])
    except ValueError as error:
        assert "ols pack" in str(error)
    else:
        raise AssertionError("expected ValueError")


def test_signature_domains_are_separate() -> None:
    manifest = json.loads((FIXTURES / "signed/manifest.ols.json").read_text(encoding="utf-8"))
    approval = json.loads((FIXTURES / "signed/approvals/diocesan-review.ols.json").read_text(encoding="utf-8"))
    assert not verify_signature(approval_signature_message(approval), manifest["signatures"][0])
    assert verify_signature(approval_signature_message(approval), approval["signatures"][0])


def test_pack_drops_signatures_only_when_digest_changes(tmp_path: Path) -> None:
    package = tmp_path / "pkg"
    shutil.copytree(FIXTURES / "signed", package)
    assert len(pack_package(package)["signatures"]) == 1
    corpus = package / "corpus.ols.json"
    corpus.write_text(corpus.read_text(encoding="utf-8").replace("Lord, have mercy.", "Lord, have mercy!"), encoding="utf-8")
    assert "signatures" not in pack_package(package)


CHANGES = FIXTURES / "changes"


def _without_derived(documents: dict) -> dict:
    manifest = {k: v for k, v in documents["manifest.ols.json"].items() if k not in ("digest", "files", "signatures")}
    return {**documents, "manifest.ols.json": manifest}


def test_rfc6902_semantics() -> None:
    document = {"a": [1, 2], "b": {"c": "x"}}
    apply_at_pointer(document, "add", "/a/-", 3)
    apply_at_pointer(document, "add", "/a/0", 0)
    apply_at_pointer(document, "remove", "/b/c")
    apply_at_pointer(document, "replace", "/a/1", 9)
    assert document == {"a": [0, 9, 2, 3], "b": {}}
    for op, path in (("test", "/a/0"), ("replace", "/missing")):
        try:
            apply_at_pointer(document, op, path, 1)
        except ChangeError:
            pass
        else:
            raise AssertionError(f"{op} {path} should fail")


def test_diff_round_trip() -> None:
    for other in ("ours", "theirs", "theirs-conflict"):
        documents = package_documents(CHANGES / "base")
        apply_changes(documents, diff_packages(CHANGES / "base", CHANGES / other))
        assert _without_derived(documents) == _without_derived(package_documents(CHANGES / other)), other


def test_diff_targets_innermost_entity() -> None:
    assert diff_packages(CHANGES / "base", CHANGES / "ours")[0] == {
        "op": "replace", "entity": "ut-kyrie-call", "path": "/text/en", "value": "Lord, have mercy upon us.",
    }


def test_merge_clean_and_conflicting(tmp_path: Path) -> None:
    result = merge_packages(CHANGES / "base", CHANGES / "ours", CHANGES / "theirs", tmp_path / "merged")
    assert result["merged"]
    assert validate_package(tmp_path / "merged").valid
    corpus = (tmp_path / "merged/corpus.ols.json").read_text(encoding="utf-8")
    assert "upon us" in corpus and "ጌታ ሆይ" in corpus
    conflict = merge_packages(CHANGES / "base", CHANGES / "ours", CHANGES / "theirs-conflict", tmp_path / "conflicted")
    assert not conflict["merged"]
    assert len(conflict["conflicts"]) == 1
    assert not (tmp_path / "conflicted").exists()


def test_apply_overlay_only_to_its_base(tmp_path: Path) -> None:
    overlay = json.loads((FIXTURES / "with-overlay/overlays/parish-kyrie.ols.json").read_text(encoding="utf-8"))
    base = FIXTURES / "with-overlay/ols_packages/org.openliturgy.dep"
    apply_overlay(overlay, base, tmp_path / "applied")
    assert "ጌታ ሆይ" in (tmp_path / "applied/corpus.ols.json").read_text(encoding="utf-8")
    try:
        apply_overlay({**overlay, "base": {**overlay["base"], "version": "9.9.9"}}, base, tmp_path / "x")
    except ValueError as error:
        assert "made for" in str(error)
    else:
        raise AssertionError("expected ValueError")


def test_overlay_diagnostics(tmp_path: Path) -> None:
    package = tmp_path / "pkg"
    shutil.copytree(FIXTURES / "with-overlay", package)
    path = package / "overlays/parish-kyrie.ols.json"
    overlay = json.loads(path.read_text(encoding="utf-8"))
    overlay["operations"][0]["path"] = "/no-such-field"
    path.write_text(json.dumps(overlay), encoding="utf-8")
    assert "OLS_OVERLAY_CONFLICT /operations/0" in [f"{d.code} {d.jsonPointer}" for d in validate_package(package).diagnostics]
    overlay["base"]["digest"] = "sha256:" + "0" * 64
    path.write_text(json.dumps(overlay), encoding="utf-8")
    assert "OLS_OVERLAY_BASE_MISMATCH" in [d.code for d in validate_package(package).diagnostics]


def test_migrate_legacy_is_valid_and_idempotent(tmp_path: Path) -> None:
    package = tmp_path / "pkg"
    shutil.copytree(FIXTURES / "legacy", package)
    assert not validate_package(package).valid
    assert len(migrate_package(package)) == 12
    assert validate_package(package).valid
    assert migrate_package(package) == []
