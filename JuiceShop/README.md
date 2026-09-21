# Per-Function Security Inventory

Extract complete TS/JS function implementations with the TypeScript compiler and evaluate each with Jev using the unchanged 28-question rubric in `questions.json`. Tooling and output live outside the cloned `juice-shop` repository.

## Run

From the JevPlayground root:

```sh
npm ci --prefix JuiceShop --ignore-scripts
npm test --prefix JuiceShop
npm run inventory --prefix JuiceShop
npm run analyze --prefix JuiceShop
```

Set `TYPESAFE_API_KEY` in your terminal environment or the ignored root `.env` file. The analyze command also accepts `JuiceShop/.env`; keep environment files private and out of Git. Never pass the key on the command line. Running analysis sends comment-stripped function source, including embedded literals, to `https://api.typesafe.ai` and incurs API usage charges. Nothing in the target repository is executed.

Use a small live check before a full run:

```sh
npm run analyze --prefix JuiceShop -- --file routes/login.ts --limit 2
```

Then run the full command again to reuse successful checkpoints. Optional flags: `--root`, `--questions`, `--output`, `--file` (relative-path substring), `--limit`, `--concurrency` (1-16, default 6), and `--model` (pinned version, default `jev-1.13.0`). The root environment file is resolved relative to JuiceShop by the npm script. Inventory-only mode never calls Jev.

## Output

Ignored `analysis-output/` contains:

- `functions.jsonl`: original declaration (`function`) and body, exact submitted text (`sanitizedFunction`), original and sanitized hashes, sanitizer version, removed-comment count, source coordinates, parent function, and file parse diagnostics for every extracted function.
- `inventory.json`: every scanned TS/JS file, parse errors, initialization counters, and explicit exclusions.
- `cache/`: atomic per-function checkpoints keyed by original source, sanitized input, sanitizer version, location, question set, and pinned model. Failed calls are retried on the next run; successful calls are reused. Comment-inclusive results are never reused for a comment-stripped run.
- `ranked.json`: every evaluated function, all question answers/probabilities/confidences, and separate relevance and review ranks.
- `report.md`: linked review queue for functions with at least one selected answer other than `not_applicable`.
- `summary.json`: selection, completion status, failures, pending function IDs, question hash, model, sanitizer version, and newly consumed input tokens.

Only one scan may write to an output directory at a time. Ctrl-C finishes a partial report after aborting in-flight requests. If forcibly terminated, successful checkpoints survive; after confirming no scan is running, remove the stale `.lock` inside the output directory before resuming.

## Interpretation And Coverage

Each function is sent as `state.function`, including its full signature and body with comments masked, with all questions in one request. The TypeScript parser identifies token boundaries in full-file context; only gaps between tokens are scanned for comments. Line comments, block comments, and JSDoc are replaced with spaces while preserving line terminators and UTF-16 offsets. Strings, regex literals, template text, JSX text, and executable code remain unchanged. Original files are never edited. Parse-error files retain best-effort sanitization and explicit warnings.

Imports, callers, and captured declarations outside the function are deliberately not added, preserving the rubric's function-only scope. Paths and provenance metadata are not included in model state. Sources are never truncated to fit a context limit: oversized requests remain failed evaluations if Jev rejects them.

Relevance is the maximum `1 - P(not_applicable)` across categories. Defect evidence is the maximum `P(local_defect)`; missing context is the maximum `P(context_required)`. These are ranking heuristics, not vulnerability probabilities. Review order puts selected local defects before missing context, locally protected operations, and not-applicable functions, with probability-based tie breakers. Protected operations remain in the inventory. Low-confidence answers are retained. Raw answers support alternative rankings without more inference.

The scanner includes frontend code, tests, static challenge snippets, and checked-in JS libraries regardless of tsconfig inclusion. It excludes `.git`, `node_modules`, `build`, `dist`, `coverage`, `.angular`, `.cache`, declaration-only files, symlinks, and non-TS/JS files. Functions include nested callbacks, expression-bodied arrows, generators, constructors, object/class methods, and accessors. Overload signatures without bodies are not separate implementations. Offsets are UTF-16 code units; lines and columns are one-based; end offsets are exclusive.

Nested functions are evaluated individually and remain inside their enclosing function's source. Results can therefore describe the same operation at multiple levels; parent IDs preserve that relationship. Files with syntax errors receive best-effort extraction and explicit warnings. Top-level executable statements and class initialization are counted but are not evaluated as functions. Templates, configuration, and operations hidden behind external helpers require separate analysis.

Completing all extracted functions does not prove exhaustive security coverage or classification accuracy. Manually validate sensitive-operation recall and top-ranked precision on representative code before relying on this queue. Comment stripping removes vulnerability hints in comments, but challenge-related identifiers and executable code remain. A single before/after comparison cannot establish that every classification change was caused by comments rather than model variability.