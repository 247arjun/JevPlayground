# Verdaccio Function Security Analysis

This workspace replicates the tested JuiceShop analysis package against the official MIT-licensed [Verdaccio repository](https://github.com/verdaccio/verdaccio). The target clone is kept under `verdaccio/`, separate from tooling and ignored generated reports.

## Target

- Repository: `https://github.com/verdaccio/verdaccio.git`
- Branch: `master`, Verdaccio's experimental 9.x line, not the current stable 6.x release.
- Initial clone revision: `297c20e93ad3065b51a0d2ba203558867d303841`.
- Model: `jev-1.13.0`.
- Rubric: the same 28 function-only Choice questions as JuiceShop, copied to `questions.json`.

## Run

From the JevPlayground root:

```sh
npm ci --prefix Verdaccio --ignore-scripts
npm test --prefix Verdaccio
npm run inventory --prefix Verdaccio
npm run analyze --prefix Verdaccio
```

The analysis command loads `TYPESAFE_API_KEY` from the process environment, root `.env`, or optional `Verdaccio/.env`. Never print or commit the key. API runs transmit function implementation text and incur usage charges. The target application is not installed or executed. Inventory-only mode makes no API calls, but overwrites reports in its output directory; use `--output` to preserve prior runs.

Flags match the copied runner: `--root`, `--questions`, `--output`, `--file` (relative-path substring), `--limit`, `--concurrency` (1-16, default 6), and `--model` (pinned version). Run without file or limit filters for the full inventory. Successful checkpoints are reused automatically; failed evaluations are retried. Separate output directories are required for fresh independent model repetitions.

## Input And Coverage

The TypeScript compiler extracts full TS/JS function implementations independently of tsconfig inclusion, including methods, arrows, constructors, accessors, and nested callbacks. Parser-guided comment masking preserves offsets, line breaks, literals, and executable tokens. Only the sanitized declaration is submitted as `state.function`; filenames and ranking metadata are not sent. Strings and identifiers remain and are not secret-redacted.

Tests, fixtures, examples, and checked-in JS are included in the scan. Dependency/generated directories, declaration-only files, symlinks, and non-TS/JS files are excluded and recorded. Top-level code, class initialization, templates, configuration, native code, and external helper behavior are not fully covered by function-only evaluation. Nested functions overlap their parent's source and must not be counted as independent findings automatically. Oversized inputs are not truncated; rejected evaluations remain explicit failures.

## Reports

Ignored `analysis-output/` contains `functions.jsonl` (original and submitted text), `inventory.json` (coverage), `cache/` (checkpoints), `ranked.json` (all answers and ranks), `report.md` (linked review queue), and `summary.json` (counts, provenance, timestamps, and failures). Full-run timing and a presentation shortlist can be saved as `timing.json` and `highest-risk.json` alongside them.

Relevance, defect evidence, and missing context are separate maximum-probability signals, not calibrated severity scores. A flagged type must have `answers[category].choice === 'local_defect'`; `relevantCategories` also contains protected and context-dependent operations. The user-facing shortlist separates application code from tests and fixtures and consolidates overlapping parent/callback results, without deleting the complete scan results.

These are model judgments requiring review, not confirmed vulnerabilities. Follow Verdaccio's security-reporting policy for independently verified findings; do not create public reports from unverified model flags. See `../.vscode/SKILL.md` for the reusable workflow.