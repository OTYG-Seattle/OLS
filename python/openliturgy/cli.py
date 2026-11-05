from __future__ import annotations

import argparse
import sys
from pathlib import Path

from .schemas import SchemaRegistry
from .validation import LAYERS, run_self_tests, validate_document, validate_package


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="ols", description="OpenLiturgy Standard SDK")
    commands = parser.add_subparsers(dest="command", required=True)
    validate = commands.add_parser("validate")
    validate.add_argument("path")
    validate.add_argument("--layer", choices=LAYERS)
    validate.add_argument("--format", choices=("text", "json"), default="text")
    validate.add_argument("--self-test", action="store_true")
    schemas = commands.add_parser("schemas")
    schema_commands = schemas.add_subparsers(dest="schema_command", required=True)
    refresh = schema_commands.add_parser("refresh")
    refresh.add_argument("--cache", default=str(Path.home() / ".cache" / "ols" / "schemas"))
    args = parser.parse_args(argv)
    try:
        if args.command == "schemas":
            SchemaRegistry.bundled().refresh(args.cache)
            return 0
        path = Path(args.path).resolve()
        result = (
            run_self_tests(path)
            if args.self_test
            else (validate_package(path) if path.is_dir() else validate_document(path))
        )
        if args.layer:
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
