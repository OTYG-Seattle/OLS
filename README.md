# OpenLiturgy Standard (OLS) v1.0 Documentation Repository

[![Astro 6](https://img.shields.io/badge/Astro-6-FF5D01?style=for-the-badge&logo=astro&logoColor=white)](https://astro.build/)
[![Tailwind CSS 4](https://img.shields.io/badge/Tailwind_CSS-4-06B6D4?style=for-the-badge&logo=tailwindcss&logoColor=white)](https://tailwindcss.com/)
[![TypeScript](https://img.shields.io/badge/TypeScript-Configured-3178C6?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue?style=for-the-badge)](./LICENSE)

This repository houses the full technical documentation and specification for the **OpenLiturgy Standard (OLS) v1.0**—a source-aware, authority-aware data standard for encoding Christian liturgical texts, actions, calendars, music, and commentary notes.

The site is built as a highly performant static documentation portal using **Astro**, **React**, and **Tailwind CSS**, based on the [andreialba/compass](https://github.com/andreialba/compass) theme.

## Architecture & Section Hierarchy

The specification is modularly divided into 44 documentation files (`.mdx`) and organized across 3 parent categories and 10 sub-categories:

1. **Specification**
   - **Introduction**: Release overview, document status, scope rules, package layout, and referencing.
   - **Metadata & Authority**: citations, source provenance, ecclesial authority review, jurisdictions, and person/org metadata.
2. **Liturgical Data Model**
   - **Core Data Model**: Localized text structures, transliterations, roles, and role inheritance.
   - **Liturgical Elements**: Spoken/chanted utterances, scripture readings, chant performance systems, inline zema alignments, rubrics, elements, blocks, and poetry.
   - **Space & Actions**: Sacred space access, rubric state transitions, timeline bindings, and propers mutations.
   - **Ordo & Calendar**: Sections, ordinary/proper slots, calendar models, deterministic resolution conflict rules, and ServiceInstances.
3. **Advanced & Profiles**
   - **Scholarly & Media**: Variants, apparatus, teaching annotations, commentary, and assets references.
   - **Schemas & Governance**: JSON schema verification, conformance levels (L0 to L7), test fixtures, and technical governance.
   - **Sharing & Distribution**: Canonical JSON, content digests, the `ols pack` / `ols verify` integrity workflow, dependency locking with `ols lock`, the JSON-LD context, PROV-O mapping, and publisher catalogs.
   - **Profiles & Examples**: EOTC Profile v1, Oriental Orthodox layers, bibliography references, and a complete corpus JSON example.

---

## Getting Started

### Local Setup

To run the documentation portal locally on your machine, you must have Node.js (>= 18.17.0) installed.

1. Clone this repository:
   ```bash
   git clone https://github.com/OTYGSeattle/OLS.git
   cd OLS
   ```
2. Install dependencies:
   ```bash
   npm install
   ```
3. Run the development server:
   ```bash
   npm run dev
   ```

Open `http://localhost:3000` in your browser.

---

## Core Build Scripts

Use the following npm commands for linting, format checks, building, and previews:

- `npm run dev`: Runs the local Astro development server.
- `npm run check`: Performs Astro diagnostics, type-checks, and content validation.
- `npm run build`: Generates the optimized production build (`dist/`), including sitemap, RSS feed, and **Pagefind static search indexes**.
- `npm run preview`: Serves the built production folder locally (recommended to test the full Pagefind search behavior).
- `npm run format`: Standardizes file formatting using Prettier.
- `npm run clean`: Cleans up local build outputs (`dist/`, `.astro/`).

Pagefind's generated full-text index is intentionally not loaded by `npm run dev`; local search suggestions remain available without requesting a missing module. Use `npm run build` followed by `npm run preview` to test complete search results.

### TypeScript and Python SDKs

This repository is also the OLS SDK monorepo. The npm workspaces publish `@openliturgy/schemas`, `@openliturgy/types`, `@openliturgy/sdk`, and `@openliturgy/cli`; `python/` publishes the unified `openliturgy` distribution. Both SDKs use the same checked-in Draft 2020-12 schemas and golden fixtures.

```bash
npm install
npm run check
npm run test --workspaces --if-present

python -m venv .venv
python -m pip install -e "python[dev]"
python -m pytest python/tests
```

Both distributions expose `ols validate PATH`, `ols validate PATH --self-test`, `ols pack PATH`, `ols verify PATH`, `ols lock PATH`, and `ols schemas refresh`. `ols pack` pins every package document by digest in `manifest.ols.json`; `ols verify` fails if anything is unpinned or changed. `ols lock` pins declared dependencies (found under `ols_packages/`) in `ols.lock.json`, and validation then resolves `dependency:id` references against them. Validation is offline by default. Node.js 20+ and Python 3.10+ are supported.

### Structured Data

Every public page embeds page-specific [Schema.org](https://schema.org/) JSON-LD, including its canonical URL and breadcrumb hierarchy. The generated [schema.json](https://ols.otyg.org/schema.json) endpoint provides the complete site graph for the organization, website, OLS standard, parent sections, categories, and all published technical articles. Because it is generated from the Astro content collection, it stays synchronized as documentation pages are added, archived, or reorganized.

Specification articles that define a closed or recommended vocabulary display a **Supported values** section with every documented value and a direct link to its definition in the generated [OLS vocabulary schema](https://ols.otyg.org/schema/v1.0/corpus.schema.json). Closed enums and open recommendation lists are explicitly distinguished. The site footer opens this OLS schema in a new tab from every page.

The OLS JSON-LD context at `/schema/v1.0/context.jsonld` lets any OLS document be read as linked data (language-tagged text, entity links, `owl:sameAs`, PROV-O provenance).

Each modeled entity also has a standalone Draft 2020-12 validator, such as `/schema/v1.0/localized-text.schema.json`, `/schema/v1.0/utterance.schema.json`, and `/schema/v1.0/rubric.schema.json`. Relevant documentation pages link directly to every entity schema they document.

---

## Document Modification and Authoring

All documentation content resides under the `src/content/docs/` directory.

### Structure

Articles are grouped by category folders, with each article having its own subfolder and `.mdx` file:

```text
src/content/docs/[category]/[slug]/[slug].mdx
```

### Frontmatter Schema

Compliant spec files must configure the Zod schema properties in their YAML frontmatter:

```mdx
---
title: 'Roles & RoleGroups'
description: 'Liturgical Roles and RoleGroups for clergy, choir, and congregation roles.'
category: 'data-model'
order: 12
updatedAt: 2026-07-01
---

## Spec Content Here
```

### Reusable Layout Components

This portal supports built-in components registered globally in `src/components/docs/mdx-components.ts` for rich specifications layouts:

- **Callouts**: `<Callout tone="info" title="Important">...</Callout>` (supports `info`, `success`, `warning`, and `danger` tones).
- **QuoteBlocks**: `<QuoteBlock author="1 Corinthians 14:40">...</QuoteBlock>` for scriptural quotes or verses.
- **Badges**: `<Badge tone="success">printed-book</Badge>` for chip metadata.
- **Tables**, **Checklists**, **Accordions**, **FileTrees**, and **CodeTabs** for structured specifications details.

---

## License

This specification and documentation repository are released under the [Apache 2.0 Spec License](./LICENSE).
