# lib — Analysis Core

contains the **core analysis and resolution logic** used by NodeAnalyzer.
All modules in this folder are **pure, side-effect-free utilities** that perform static
inspection, dependency resolution, and metadata extraction.

No HTTP, UI, or persistence concerns exist here.

---

## Architecture Overview

The analysis pipeline is intentionally layered:

buildMetricsFromEntrypoint
↓
parseFile
↓
resolveImports

Each layer has a single responsibility and can be evolved independently.

---

## Modules

### `buildMetricsFromEntrypoint.js`

**Role:** Orchestrator / graph builder

Starting from a single entrypoint file, this module:

- Traverses the internal import graph (breadth-first)
- Invokes `parseFile()` on each discovered source file
- Resolves local dependencies via `resolveImports()`
- Emits a normalized metrics payload for D3 rendering

**Responsibilities:**
- Graph traversal
- Node and edge construction
- Path normalization
- Aggregation of metrics

**Does NOT:**
- Parse ASTs directly
- Perform semantic analysis
- Interact with HTTP or the filesystem beyond reading files

---

### `parseFile.js`

**Role:** Lightweight static extraction

Parses a single JS/TS source file and extracts:

- Import specifiers (ESM + CommonJS)
- Non-empty lines of code (LOC)
- Heuristic complexity score

Parsing is **best-effort**:
- Syntax errors do not abort analysis
- Mixed JS / TS projects are supported
- No type resolution is attempted

This module is designed for **high signal / low cost** analysis and is the
foundation for future symbol-level (function / call graph) extraction.

---

### `resolveImports.js`

**Role:** Dependency resolver

Resolves import specifiers to concrete filesystem paths.

Supported patterns:
- Relative imports (`./`, `../`)
- Implicit extensions (`.js`, `.ts`, `.jsx`, `.tsx`)
- Directory index files (`index.js`, etc.)

This module intentionally avoids:
- Node module resolution (`node_modules`)
- Package exports / conditional exports
- Runtime or dynamic resolution

It exists to keep the dependency graph **project-internal and deterministic**.

---

### `probeAppUrl.js`

**Role:** Runtime metadata probe (optional)

Attempts to probe a running application URL to extract **non-structural metadata**
(e.g. availability, response headers).

Important:
- Results are purely informational
- Analysis correctness does not depend on this module
- Failures are tolerated and ignored by the pipeline

---

## Design Principles

- **Pure functions** where possible
- **Deterministic output** for a given codebase
- **Fail-soft behavior** (analysis should never crash on imperfect code)
- **Extensible by design** (future PHP support, symbol graphs, metrics enrichment)

---

## Future Extensions (Planned)

- Function and method extraction
- Call-graph generation
- Symbol-level navigation
- Language adapters (PHP, others)
- Complexity heuristics per function

All future work should build on these primitives rather than bypassing them.

---

## Usage Context

This directory is consumed by:
- HTTP routes (`/analyze`)
- CLI tooling (future)
- Internal testing and experimentation

It should remain **framework-agnostic** and **UI-agnostic**.