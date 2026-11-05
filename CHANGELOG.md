# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog, and this project follows semantic versioning when tagged for GitHub releases.

## [Unreleased]

### Added

- **Canonical form and content digests.** OLS canonical JSON is RFC 8785 (JCS) after Unicode NFC normalization, with shared test vectors in `fixtures/canonical/vectors.json`. `canonicalize`, `canonicalDigest`, and `packageDigest` (Python: `canonicalize`, `canonical_digest`, `package_digest`) are exported by both SDKs.
- `manifest.files` entries may be `{ path, digest, mediaType }`. `manifest.digest` pins the whole package. Assets accept `digest`, `byteSize`, and `mediaType`.
- `validatePackage` checks every declared digest (`OLS_FILE_DIGEST_MISMATCH`, `OLS_PACKAGE_DIGEST_MISMATCH`, `OLS_ASSET_DIGEST_MISMATCH`, `OLS_ASSET_SIZE_MISMATCH`) and warns about missing package-local asset files (`OLS_ASSET_NOT_FOUND`).
- `ols pack` / `packPackage` / `pack_package` pin every document and recompute the package digest. `ols verify` / `verifyPackage` / `verify_package` additionally require everything to be pinned (`OLS_FILE_UNPINNED`, `OLS_ASSET_UNPINNED`, `OLS_PACKAGE_DIGEST_MISSING`).
- New *Sharing & Distribution* docs category with an *Integrity & Canonical Form* article.
- `npm run schemas:provenance` recomputes schema provenance digests and syncs the Python schema copy.

### Changed

- TypeScript diagnostics are sorted by UTF-16 code unit instead of `localeCompare`, matching Python's ordering exactly.
- The parity gate compares `ols verify` reports and byte-for-byte `ols pack --stdout` output.

### Fixed

- **Cross-package references no longer resolve to same-named local entities.** In both SDKs, `<package>:<id>` now resolves locally only when `<package>` is the manifest's own `package`. A reference into a declared dependency reports `OLS_REF_EXTERNAL` (info), and a reference into an undeclared package reports only `OLS_DEPENDENCY_UNDECLARED`, no longer alongside a duplicate `OLS_REF_UNRESOLVED`. `resolveReference` / `resolve_reference` take an optional package name, and a new `packageQualifier` / `package_qualifier` helper splits qualified references.
- ID-valued fields are now reference-checked like `$ref`, in both SDKs: `section.blocks`, `ordo.sections`, `proper.ordos`, `utterance.roles`, `reading.role`, `role.inherits`, `role-group.roles`, `rubric.actors`, `asset.linkedTo`, `teaching-note.target`, `conflict-rule.winner`/`overrides`, `service-instance.ordo`/`activePropers`, `liturgical-day.readings`/`activePropers`, and `execution-timeline.target`. Previously a section could list a block that did not exist and still pass. These fields also feed cycle detection, so role-inheritance loops are reported.
- `urn:ols:<ref>` resolves `<ref>` with the normal rules and falls back to the legacy `:` to `.` mapping. Reference-cycle detection now follows package-qualified, URN, and path references, not only exact IDs.
- All 35 schemas accept `ols_version` `1.1.x`, matching the SDKs and the 1.1 documentation. Previously every 1.1 document failed schema validation.
- `LocalizedText` keys accept the full BCP 47 grammar in canonical case (`en-US`, `pt-BR`, `es-419`, `de-CH-1996`, `gez-Latn-x-ies`). Previously only `language` or `language-Script` was accepted.
- The `corpus` schema referenced a missing `#/$defs/Mutation` definition, which crashed TypeScript package validation of any corpus. The embedded mutation definition in `corpus` and `proper` now matches `mutation.schema.json` and the docs (`op` + `target`; `type` optional).
- Documentation examples no longer use `{ "$ref": ... }` objects inside ID lists (`blocks`, `sections`), which the schemas reject. `RoleGroup` uses `roles` instead of `members`, roles use `label` instead of `labels`, the execution-timeline entry uses `type`/`kind`, and a duplicated "Binding Rules" section is removed. A new SDK test validates every typed JSON example in the spec against its schema.
- `tools/bootstrap-schemas.mjs` no longer reintroduces the broken mutation definition if it is re-run.
- Documentation examples now use `"type": "<entity>"` plus `"kind": "<subtype>"` as the schemas require, in place of the subtype in `type`. The complete corpus example now validates, and an SDK test keeps it that way.

### Changed

- The parity gate now compares package-directory validation (it previously compared only document validation of the manifest) and a new `fixtures/cross-package` package.
- The IDs article documents the reference resolution order. The LocalizedText and Schemas articles document the language-tag grammar.

## [1.1.0] - 2026-07-02

### Added

- Translation Variants: support for multiple translation variants of the same text within a single language, with provenance, labels, and default selection rules.
- New `data-model/translation-variants` specification article documenting schema pattern, variant object fields, resolution rules, and SDK implementation guide.
- Full JSON Schema definition for `LocalizedText` including `TranslationVariantsMap` and `TranslationVariant` types.
- Eight formal validation rules (`OLS_VARIANT_*`) with error/warning/info severities for translation variant integrity.
- Five Utterance validation rules (`OLS_UTT_*`) for structural correctness.
- Seven test fixtures (valid and invalid) for translation variant validation.
- Conformance level requirements (L0–L5) for translation variant support.
- Cross-reference callout in `LocalizedText` article linking to the new variants documentation.
- Distinction callout in Scholarly Variants article clarifying manuscript variants vs. translation variants.
- Updated complete corpus example to demonstrate translation variants with provenance.

## [1.0.1] - 2026-07-01

### Added

- Added canonical checked-in OLS v1.0 schemas, shared conformance fixtures, TypeScript `@openliturgy/*` workspaces, and the Python `openliturgy` distribution.
- Added offline package loading, reference resolution, six-layer validation, stable diagnostics, self-test runners, matching `ols` CLIs, schema refresh caches, and cross-language parity checks.
- Added multi-platform SDK CI, manually triggered npm/PyPI release dry-run workflows, and the tag-triggered automated production release workflow.

### Fixed

- Fixed Node 24 compatibility by making the `esbuild` override global, preventing peer dependency mismatch on Linux runners.
- Upgraded CI Node.js version targets and release dry-run workflows from Node 20 to 22/24 to support Astro 6 requirements.
- Configured `.gitattributes` to enforce `LF` line endings for all JSON files, resolving schema check failures on Windows CI runners.

### Changed

- Reserved `type` for OLS entity identity and introduced `kind` for domain subtypes.
- Changed public schema routes to serve canonical checked-in artifacts rather than dynamic schema objects.

- Added a complete Schema.org JSON-LD graph at `/schema.json` and page-specific structured data for every public landing page, category, and specification article.
- Set `https://ols.otyg.org` as the canonical domain and added a visible footer link that opens the OLS JSON Schema in a new tab.
- Corrected repository links from `OTYGSeattle/OSL` to `OTYGSeattle/OLS`.
- Prevented the development server from requesting the production-only Pagefind module, eliminating the disallowed MIME-type browser error.
- Added visible supported-value lists to relevant specification articles and generated an OLS v1.0 JSON Schema vocabulary endpoint with direct definition links.
- Added standalone Draft 2020-12 JSON Schema validators for 35 modeled OLS entities, including localized text, utterances, readings, rubrics, blocks, sections, roles, citations, calendars, and service instances.
- Expanded all OLS specification articles with practical usage guidance, connected JSON samples, validation notes, edge cases, and a complete minimal corpus walkthrough.
- Fixed scripture citation labels that displayed Markdown emphasis markers as literal text.
- Migrated OpenLiturgy Standard (OLS) v1.0 single-page specification from `base.html` into a full documentation repository using Astro, React, and Tailwind CSS.
- Split the specification into 40 structured MDX articles, organized into 3 parent categories and 9 sub-categories.
- Integrated theme-specific custom MDX components (like Callouts, Badges, QuoteBlocks, and Tables) for richer specification aesthetics.
- Updated site settings and configured Pagefind static search for OpenLiturgy.

## [1.0.0] - 2026-06-19

### Added

- First stable Compass template release for product docs, support centers, and internal knowledge bases.
- Astro 6 and Tailwind CSS 4 project setup with MDX content collections.
- Parent landing pages, nested sub-category pages, article pages, breadcrumbs, and previous/next article navigation.
- Pagefind-powered static search for the homepage and docs sidebar.
- Reusable MDX docs components for callouts, badges, cards, card grids, buttons, tabs, code tabs, file trees, tables, accordions, steps, checklists, and quotes.
- Article frontmatter for descriptions, tags, lifecycle status, authors, edit links, hero images, redirects, related links, search visibility, ordering, and update dates.
- Locally hosted Geist fonts, light/dark mode, favicons, Open Graph image support, RSS feed generation, and sitemap generation.
- Browser enhancements for article table of contents, code-copy controls, image lightbox behavior, keyboard-friendly search, and accessible search result state.
