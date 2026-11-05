from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .schemas import SchemaRegistry
from .trust import generate_signing_key
from .validation import (
    LAYERS,
    apply_overlay,
    create_overlay,
    diff_packages,
    lock_package,
    merge_packages,
    migrate_package,
    pack_package,
    run_self_tests,
    sign_approval,
    sign_package,
    validate_document,
    validate_package,
    verify_package,
)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="ols", description="OpenLiturgy Standard SDK")
    commands = parser.add_subparsers(dest="command", required=True)
    validate = commands.add_parser("validate")
    validate.add_argument("path")
    validate.add_argument("--layer", choices=LAYERS)
    validate.add_argument("--format", choices=("text", "json"), default="text")
    validate.add_argument("--self-test", action="store_true")
    validate.add_argument("--keyring")
    verify = commands.add_parser("verify")
    verify.add_argument("path")
    verify.add_argument("--format", choices=("text", "json"), default="text")
    verify.add_argument("--keyring")
    keygen = commands.add_parser("keygen")
    keygen.add_argument("--out", required=True)
    sign = commands.add_parser("sign")
    sign.add_argument("path")
    sign.add_argument("--key", required=True)
    sign.add_argument("--signer")
    pack = commands.add_parser("pack")
    pack.add_argument("path")
    pack.add_argument("--stdout", action="store_true")
    lock = commands.add_parser("lock")
    lock.add_argument("path")
    lock.add_argument("--packages-dir", default="ols_packages")
    lock.add_argument("--stdout", action="store_true")
    diff = commands.add_parser("diff")
    diff.add_argument("base")
    diff.add_argument("other")
    diff.add_argument("--overlay")
    apply = commands.add_parser("apply")
    apply.add_argument("overlay")
    apply.add_argument("--base", required=True)
    apply.add_argument("--out", required=True)
    merge = commands.add_parser("merge")
    merge.add_argument("base")
    merge.add_argument("ours")
    merge.add_argument("theirs")
    merge.add_argument("--out", required=True)
    migrate = commands.add_parser("migrate")
    migrate.add_argument("path")
    migrate.add_argument("--dry-run", action="store_true")
    schemas = commands.add_parser("schemas")
    schema_commands = schemas.add_subparsers(dest="schema_command", required=True)
    refresh = schema_commands.add_parser("refresh")
    refresh.add_argument("--cache", default=str(Path.home() / ".cache" / "ols" / "schemas"))
    args = parser.parse_args(argv)
    try:
        if args.command == "schemas":
            SchemaRegistry.bundled().refresh(args.cache)
            return 0
        if args.command == "diff":
            base, other = Path(args.base).resolve(), Path(args.other).resolve()
            result: object = create_overlay(base, other, args.overlay) if args.overlay else diff_packages(base, other)
            print(json.dumps(result, indent=2, ensure_ascii=False))
            return 0
        if args.command == "apply":
            overlay = json.loads(Path(args.overlay).read_text(encoding="utf-8"))
            print(apply_overlay(overlay, args.base, args.out)["digest"])
            return 0
        if args.command == "merge":
            merged = merge_packages(args.base, args.ours, args.theirs, args.out)
            if merged["merged"]:
                print(merged["manifest"]["digest"])
                return 0
            print(json.dumps({"conflicts": merged["conflicts"]}, indent=2, ensure_ascii=False))
            return 1
        if args.command == "migrate":
            print(json.dumps(migrate_package(args.path, write=not args.dry_run), indent=2, ensure_ascii=False))
            return 0
        if args.command == "keygen":
            private_key_pem, public_key = generate_signing_key()
            out = Path(args.out)
            with open(out, "x", encoding="ascii") as handle:
                handle.write(private_key_pem)
            out.chmod(0o600)
            print(public_key)
            return 0
        path = Path(args.path).resolve()
        keyring = (
            json.loads(Path(args.keyring).read_text(encoding="utf-8")) if getattr(args, "keyring", None) else None
        )
        if args.command == "sign":
            private_key_pem = Path(args.key).read_text(encoding="ascii")
            entry = (
                sign_package(path, private_key_pem, args.signer)
                if path.is_dir()
                else sign_approval(path, private_key_pem, args.signer)
            )
            print(f"Signed with {entry['key']}")
            return 0
        if args.command == "lock":
            lockfile, manifest_updated = lock_package(path, args.packages_dir, write=not args.stdout)
            if args.stdout:
                print(json.dumps(lockfile, indent=2, ensure_ascii=False))
            else:
                note = " Added ols.lock.json to manifest files; run `ols pack` to re-pin." if manifest_updated else ""
                print(f"Locked {len(lockfile['packages'])} dependencies.{note}")
            return 0
        if args.command == "pack":
            manifest = pack_package(path, write=not args.stdout)
            print(json.dumps(manifest, indent=2, ensure_ascii=False) if args.stdout else manifest["digest"])
            return 0
        if args.command == "verify":
            result = verify_package(path, keyring)
        else:
            result = (
                run_self_tests(path)
                if args.self_test
                else (validate_package(path, keyring=keyring) if path.is_dir() else validate_document(path))
            )
        if getattr(args, "layer", None):
            last = LAYERS.index(args.layer)
            result.diagnostics = [item for item in result.diagnostics if LAYERS.index(item.layer) <= last]
            result.valid = not any(item.severity == "error" for item in result.diagnostics)
        if args.format == "json":
            print(result.model_dump_json(indent=2, exclude_none=True))
        else:
            for item in result.diagnostics:
                print(f"{item.severity.upper()} {item.code} {item.source}{item.jsonPointer}: {item.message}")
            print("OLS validation passed." if result.valid else "OLS validation failed.")
        return 0 if result.valid else 1
    except Exception as error:  # noqa: BLE001 - any failure is reported as exit code 2, like the TypeScript CLI
        print(str(error), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
