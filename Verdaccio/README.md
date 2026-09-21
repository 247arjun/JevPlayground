# Verdaccio Function Security Analysis

This workspace replicates the tested JuiceShop analysis package against the official MIT-licensed [Verdaccio repository](https://github.com/verdaccio/verdaccio). The target clone is kept under `verdaccio/`, separate from tooling and ignored generated reports.

## Target

- Repository: `https://github.com/verdaccio/verdaccio.git`
- Branch: `master`, Verdaccio's experimental 9.x line, not the current stable 6.x release.
- Initial clone revision: `297c20e93ad3065b51a0d2ba203558867d303841`.
- Model: `jev-1.13.0`.
- Primary rubric: 43 operation-first Choice questions in `questions.json`, covering operations, input sources, influence, guards, output channels, and missing context.
- Archived rubric: 28 defect-class questions in `questions.defects.json`, retained for reproducing earlier runs.

## Run

From the JevPlayground root:

```sh
npm ci --prefix Verdaccio --ignore-scripts
npm test --prefix Verdaccio
npm run inventory --prefix Verdaccio
npm run analyze --prefix Verdaccio
```

The analysis command loads `TYPESAFE_API_KEY` from the process environment, root `.env`, or optional `Verdaccio/.env`. Never print or commit the key. API runs transmit function implementation text and incur usage charges. The target application is not installed or executed. Inventory-only mode makes no API calls, but overwrites reports in its output directory; use `--output` to preserve prior runs.

Flags: `--root`, `--questions`, `--output`, `--file` (relative-path substring), `--limit`, `--concurrency` (1-16, default 6), and `--model` (pinned version). Run without file or limit filters for the full inventory. Successful checkpoints are reused automatically; failed evaluations are retried. Separate output directories are required for fresh independent model repetitions. The runner rejects an output directory belonging to a different root, model, rubric, or sanitizer version.

Classification mode is detected from the question labels and defaults to `analysis-output/classification/`. This leaves the historical defect results in `analysis-output/` untouched. To explicitly run the archived defect rubric:

```sh
npm run analyze --prefix Verdaccio -- --questions ./questions.defects.json
```

Relative flag paths are resolved from the package directory when using `npm --prefix`. The copied JuiceShop runner has not yet been adapted for the classifier.

## Input And Coverage

The TypeScript compiler extracts full TS/JS function implementations independently of tsconfig inclusion, including methods, arrows, constructors, accessors, and nested callbacks. Parser-guided comment masking preserves offsets, line breaks, literals, and executable tokens. Only the sanitized declaration is submitted as `state.function`; filenames and ranking metadata are not sent. Strings and identifiers remain and are not secret-redacted.

Tests, fixtures, examples, and checked-in JS are included in the scan. Dependency/generated directories, declaration-only files, symlinks, and non-TS/JS files are excluded and recorded. Top-level code, class initialization, templates, configuration, native code, and external helper behavior are not fully covered by function-only evaluation. Nested functions overlap their parent's source and must not be counted as independent findings automatically. Oversized inputs are not truncated; rejected evaluations remain explicit failures.

## Reports

Ignored `analysis-output/classification/` contains:

- `classifications.json`: every successfully evaluated function with all 43 answers, raw probabilities, confidence, model, evaluation timestamp, question hash, and request key. Original source coordinates, hashes, nesting, and sanitizer metadata are retained.
- `questions.snapshot.json`: the exact rubric for interpreting these saved answers, independent of later question edits.
- `functions.jsonl`: original and sanitized source for every extracted function. Join its `id` with a classification's `id` to recover the exact submitted implementation.
- `inventory.json`: scanned files, exclusions, initialization counters, and parse diagnostics.
- `run.json`: schema version, mode, source root, pinned model, rubric hash, sanitizer version, and result filename.
- `cache/`: per-function response checkpoints. The classification's `requestKey` identifies its cache filename.
- `summary.json`: completeness, counts, failed and pending IDs, per-invocation timestamps, elapsed seconds, and newly consumed input tokens.
- `report.md`: source-linked classification table, not a vulnerability ranking.

For later stages, load `classifications.json` and `questions.snapshot.json`; join to `functions.jsonl` only when source is needed. All `absent` and `unclear` answers remain available. `presentCategories` and `unclearCategories` are convenience indexes, not risk scores. `guardFailureBehavior` preserves the distinct guard-flow answer. The presence of a guard does not prove every operation is protected, and independent dimensions may concern different operations within the same function.

The completed classification snapshot also includes `dataset.json` (revision, schema, counts, join keys, artifact sizes and SHA-256 hashes), `provenance.json` (target revision and previous-report hashes), `category-counts.json` (selected-label counts per question), and `timing.json` (full-run and retry timing). This snapshot contains 6,618 functions and 284,574 answers. These supplemental audit artifacts describe this completed run; regenerate them if running again with changed sources or inputs. Classification counts include tests and nested functions and are not independent vulnerability counts.

The historical defect output remains under `analysis-output/`, with `ranked.json`, `highest-risk.json`, and its prior rubric/hash. Do not interpret those old labels as results from the new classifier.

In legacy defect mode, relevance, defect evidence, and missing context are separate maximum-probability signals, not calibrated severity scores. A flagged type must have `answers[category].choice === 'local_defect'`; `relevantCategories` also contains protected and context-dependent operations. Classification mode deliberately produces no defect labels or risk ranking.

These are model judgments requiring review, not confirmed vulnerabilities. Follow Verdaccio's security-reporting policy for independently verified findings; do not create public reports from unverified model flags. See `../.vscode/SKILL.md` for the reusable workflow.