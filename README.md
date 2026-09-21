# JevPlayground

Experiments with [TypeSafe's Jev](https://docs.typesafe.ai/introduction) for structured, question-driven code analysis. The first experiment uses OWASP Juice Shop to explore per-function security triage across JavaScript and TypeScript code.

This is an experimental analysis workspace, not a vulnerability scanner with verified detection accuracy. Model classifications guide human review; they do not establish exploitability or prove that code is secure.

## What's Here

| Resource | Purpose |
| --- | --- |
| [JuiceShop](JuiceShop/README.md) | Function extraction, comment masking, Jev evaluation, resumable checkpoints, and ranked review reports. |
| [Security questions](JuiceShop/questions.json) | A rubric of 28 security categories, each evaluated independently against one function. |
| [Sample state](JuiceShop/state.json) | An example function from OWASP Juice Shop, separate from the inventory runner. |
| [Analysis workflow](.vscode/SKILL.md) | Reusable guidance for pilots, comparisons, coverage, and interpretation. |

Target repositories, dependencies, credentials, and generated analysis results stay local. The nested Juice Shop clone is deliberately excluded from this repository.

## Getting Started

Requirements: Git, npm, and Node.js 22.9+ or a newer supported LTS release.

From a fresh checkout:

```sh
git clone https://github.com/247arjun/JevPlayground.git
cd JevPlayground
git clone https://github.com/juice-shop/juice-shop.git JuiceShop/juice-shop
npm ci --prefix JuiceShop --ignore-scripts
npm test --prefix JuiceShop
```

The nested clone is input data. You do not need to install its dependencies or start the Juice Shop application. For reproducible comparisons, record and reuse the target repository's commit.

### Offline Inventory

```sh
npm run inventory --prefix JuiceShop
```

This extracts functions and writes local inventory artifacts without making TypeSafe API calls or requiring an API key.

### Jev Evaluation

Set `TYPESAFE_API_KEY` in your environment or add it locally to an ignored `.env` file at the JevPlayground root:

```dotenv
TYPESAFE_API_KEY=
```

Enter your key after `=` in your local editor, keep the file private, and never commit it. The runner also accepts a local environment file inside JuiceShop. On macOS or Linux, restrict a credential file to its owner with `chmod 600 .env`.

Start with a small pilot:

```sh
npm run analyze --prefix JuiceShop -- --file routes/login.ts --limit 2
```

API analysis sends function source to TypeSafe and incurs usage charges. Comments are masked, but string literals and any embedded secrets remain: only analyze code you are authorized to transmit.

After reviewing the pilot, a full run can reuse successful checkpoints:

```sh
npm run analyze --prefix JuiceShop
```

Generated inventories, cached responses, and ranked reports are written under the ignored `JuiceShop/analysis-output/` directory. Runs using the same output directory rewrite its current reports; preserve any results needed for comparisons first.

See the [JuiceShop README](JuiceShop/README.md) for command options, output formats, sanitization behavior, and coverage limitations.

## Interpreting Results

Each category selects one of `not_applicable`, `locally_protected`, `local_defect`, or `context_required`. The assessment is limited to the function shown, without external callers, imports, or helper implementations. Rankings prioritize review candidates; model probabilities are not calibrated vulnerability severity or exploitability scores. Nested functions overlap with their parents, so findings may describe the same operation more than once.

## Local Files And Publication

The ignore rules exclude environment files, dependency directories, the nested Juice Shop clone, default analysis output, npm debug logs, and local editor command-approval settings. Keep dependency manifests and lockfiles versioned so other users can install the tooling. If you choose a custom output directory, ensure it is ignored before writing potentially sensitive source or reports there.

## License

JevPlayground is MIT-licensed; the repository's existing license file contains the terms. OWASP Juice Shop is a separate project with its own [MIT license](https://github.com/juice-shop/juice-shop/blob/master/LICENSE); retain applicable upstream notices when redistributing its code.