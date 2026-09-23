# Jeeves

A local, classification-guided security investigation CLI for TS/JS and C#. It imports an existing Jev dataset, verifies and snapshots its source, indexes candidate relationships, plans bounded operations for review, and coordinates separate GitHub Copilot localizer, investigator, and challenger sessions.

This is a working first implementation, not a complete security analyzer. Findings remain model hypotheses unless independently validated. The implementation boundaries below are important: the longer-term design in `plan.md` is not a claim that every planned capability is complete.

## Requirements And Build

- Node.js 24+ with `node:sqlite`; Node 26.8.2 was used for verification. Older Node releases may label the SQLite API experimental.
- The pinned GitHub Copilot SDK runtime, installed as an optional platform package, and an authorized GitHub Copilot login or supported GitHub token environment variable. Never pass tokens as command-line arguments.
- .NET SDK 8.0.407 (or an allowed patch) to build the Roslyn sidecar.
- A running Docker daemon and a locally available digest-pinned image only for explicitly approved validation. Docker is not needed for import, indexing, reporting, or ordinary investigation.

From the workspace root:

```sh
npm ci --prefix Jeeves --ignore-scripts
npm run test:all --prefix Jeeves
node Jeeves/dist/src/cli.js doctor
node Jeeves/dist/src/cli.js --help
```

`npm test --prefix Jeeves` builds TypeScript and runs offline tests. C# integration tests explicitly skip when its sidecar has not been built; `test:all` builds it first. The .NET build restores only Jeeves' pinned Roslyn dependency, not any target repository. Target builds, analyzers and generators are never run by the navigation code.

## Offline Workflow

```sh
node Jeeves/dist/src/cli.js import \
  --dataset /absolute/path/to/classification-dataset \
  --repo /absolute/path/to/matching-source \
  --run Jeeves/runs/review-001

node Jeeves/dist/src/cli.js index --run Jeeves/runs/review-001
node Jeeves/dist/src/cli.js plan --run Jeeves/runs/review-001 --mode full
node Jeeves/dist/src/cli.js status --run Jeeves/runs/review-001
```

The importer accepts the version-1 dataset manifest used by the existing classifier: `dataset.json`, its checksummed `inventory.json`, rubric snapshot, function JSONL, and classification JSON array. Manifest filenames are used instead of hardcoding a target. It validates file sizes/hashes, source spans, sanitized hashes, answer labels/distributions and counts. Partial imports can be replayed idempotently; a different dataset requires a new run directory.

Imports snapshot the classified source, additional TS/JS/C# source, templates, JSON/YAML and other declared configuration, and README/security/contribution documents. Public/static resources also have a metadata inventory. Additional source is reported separately and is not treated as Jev-classified. Environment/key/credential-named files, installed dependencies, build output and symlinks are excluded explicitly. Capture is bounded to 16 MiB per file and 512 MiB total; omissions are recorded, and exceeding the total stops import. Relevant configuration can contain literal secrets despite filename exclusions; review the source-disclosure policy before a live run. A snapshot makes input stable, not public or redacted. Imported sanitized implementations are independently checked against parser-based comment masking.

The expanded `source-and-context-v2` snapshot policy requires a fresh run for old datasets. The original Jev dataset and all successful classification answers are reused unchanged; Jeeves does not call Jev. Changed snapshot/index/planning/prompt identities cannot be mixed into an old investigation. Previous-run syntax reuse and `status` open the database read-only.

The index stores syntactic call and registration candidates, checkpointed by completed file. Interrupted generations replay only incomplete files. Semantic programs are loaded only when a tool explicitly requests a project context. A name-based reverse lookup is deliberately labeled incomplete. The additional `find_semantic_callers` tool follows compiler-resolved targets within one selected TS/JS or C# project and pages its progress; other projects, dynamic dispatch and external consumers remain explicit gaps. `trace_local_value` returns operand declarations, parameter boundaries, candidate writes and enclosing conditions, not a path-sensitive taint proof.

Planning defaults to **full review**, with no 25/50/200 candidate cutoff. Every eligible function/theme and parsed non-function subject is persisted in a candidate catalogue. Functions without a matching signal receive a general-review obligation; uncertain signals are retained. Multiple themes per function are allowed. Cryptography, recovery, ownership, redirects, resource limits, parsing, business policy and disclosure have explicit review contracts. Ownership reviews do not require an existing authorization check to be classified present.

Path and project-configuration evidence distinguishes application candidates, initialization, fixtures, tooling and vendor material. These are declared-purpose heuristics, not runtime proof. An application route's imported handler reference overrides a path-only exclusion while retaining both pieces of evidence. Exclusions remain visible in the catalogue; `--include-non-application` expands the declared scope. Build exclusion alone never establishes safety. Request-input signals and declared route relationships affect order, not full-review inclusion.

Use `plan --run RUN --mode sample --max-operations N` only for a deliberately sampled experiment. Selection uses evidence priority and file/theme diversity rather than alphabetical truncation, with about 20% deterministic controls when available. All unselected candidates remain `deferred`. There is no fixed upper candidate limit. Exact subject/theme identity prevents duplicate task insertion; final identical operation/theme spans are grouped without deleting parent or caller evidence. These groups are not distinct-vulnerability counts, and semantic deduplication across different operations still requires review.

Context indexing uses bounded parser workers for TS declarations, HTML anchors, and JSON/YAML configuration. It records declared imports, component/template links, route/middleware arguments and imported Finale CRUD registrations. The scoped `inspect_context`, `inspect_relationships`, `list_subjects`, and `list_public_assets` tools return evidence candidates. `search_snapshot` uses a local trigram index with path prefixes and generation-bound pagination instead of scanning the first alphabetical files on every call. Short searches require at least three characters. Framework relationships are not executable call-graph or dataflow proofs; parser failures, unsupported formats and files without reviewable declarations remain explicit gaps. C# source is comment-masked for search; unclassified C# files get a source-file review obligation with Roslyn operation validation, while cross-framework relationship coverage remains partial.

## Live Investigation

```sh
node Jeeves/dist/src/cli.js run \
  --run Jeeves/runs/review-001 \
  --model gpt-5-mini \
  --workers 2 \
  --config Jeeves/config/defaults.json \
  --max-run-hours 4 \
  --allow-live

node Jeeves/dist/src/cli.js report --run Jeeves/runs/review-001
```

Choose an available model explicitly. `--allow-live` authorizes transmission of selected source, classifications, and retrieved evidence to the configured GitHub Copilot service. Jeeves does not silently switch models or providers. Azure-hosted custom providers are not wired in this version.

Each operation progresses through isolated localizer, investigator and challenger sessions unless an earlier result refutes the hypothesis or finds no relevant operation. Tools enforce source membership, bounded spans, comment masking, evidence citations and AST operation locations. The model cannot call shell, arbitrary URL, write, MCP or agent-spawning tools. Unknown permissions fail closed. Runtime configuration discovery, repository instructions and persistent memory are disabled.

Investigation agents cannot mark a finding as locally reproduced. They submit `needs_context`, `supported_candidate`, `refuted_hypothesis`, `no_relevant_operation` or `budget_exhausted`. The validation executor records raw observations separately and requires review.

There is no default run-wide session/candidate cap. A live command requires an explicit overall budget: `--max-run-hours`, `--max-role-calls`, `--max-run-requests`, or corresponding non-null config values. The four-hour example is illustrative, not a required limit. Time is cumulative active run time; an unclean shutdown conservatively charges time until recovery. Session attempts and observed provider usage persist across resumes. A reached overall budget leaves unfinished tasks queued with an explicit pause reason, not falsely completed.

Default per-attempt limits remain 20 observed provider requests, 40 admitted tool calls and a 120-second deadline, with two workers. `--attempt-seconds` permits an explicitly approved longer attempt up to the configured schema bound; worker, byte and heap limits still apply. One tool slot is reserved for structured submission. Tool results expose remaining budgets; retrieval closes near the provider/deadline boundary so the agent can submit unresolved evidence. An idle session without an accepted result gets at most one submission-only reminder within the same budget and original deadline. Already validated results survive subsequent shutdown or provider-budget cancellation; late results after cancellation are rejected.

`read_source` caps an overshooting end offset at EOF and returns the actual citation span and file length. Source withheld by output limits is not valid citation evidence. Safe error counts and rejected tool calls are recorded separately from admitted calls, without raw error bodies. SDK usage events are recorded without prompt content; absent token fields remain unknown. Session-call counts and provider cost multipliers are not currency totals. An optional `maxAiCreditsPerSession` uses the SDK's provider-side limit when supported. The observed request guard aborts when its boundary event arrives and is not a prebilling exactly-once guarantee; retain provider/account quotas. Authentication, billing and rate-limit errors stop further task admission. Unsubmitted exhausted work remains queued or failed, and the CLI exits nonzero when tasks are not completed. An accepted `budget_exhausted` result is still inconclusive, even when its task is completed.

## Persistence And Recovery

`runs/<run>/state.sqlite` is the canonical WAL-backed metadata, task, lease and event store. Database requests run in a bounded worker, use parameterized values, and never hold a transaction during a model call. Content-addressed JSON artifacts contain source records, requests, evidence and accepted results. Source snapshots are read-only.

Every result is bound to task, attempt, role, source hashes, model identity and prompt version. Stale attempts cannot accept results after a task is reclaimed. Successful task stages are not repeated on resume.

```sh
node Jeeves/dist/src/cli.js resume \
  --run Jeeves/runs/review-001 --model gpt-5-mini --allow-live --retry-failed
```

Explicit `--retry-failed` retries a failed role only while it has fewer than three recorded attempts. Expired running leases are fenced and requeued. Run-level call usage is retained. To recover a stale coordinator lock, use `resume --run ... --recover-lock`; it refuses when the recorded owner process is alive. Do not manually delete a live lock.

`resume --continue-inconclusive` is an explicit request to revisit accepted `needs_context` or `budget_exhausted` results, retaining prior evidence and limiting repeated role attempts. Supply approved budget/attempt overrides when needed; neither continuation nor retry resets accumulated usage. Without an explicit config, resume reuses the recorded limits.

Agents may submit up to five separately cited `followUps` and explicit cross-boundary `flow` records. Proposals are source/anchor validated, deduplicated, and depth-limited to three; they never silently start more live work. Inspect `reports/followups.jsonl`, then use `approve-followups --run RUN --followups ID[,ID...] --approve-followups` to admit the chosen proposals. Approved subjects are anchored to the exact cited operation and preserve the originating subject/rationale, so another operation in the same function/theme is not lost. An equivalent anchored task or already-reviewed operation is not repeated. Approved tasks share the same run budget. This is a read-only defensive review queue, not autonomous target testing or exploit generation.

Reports are streamed to `reports/investigations.json`, `reports/summary.md`, `reports/coverage.json`, `reports/candidates.jsonl`, and `reports/followups.jsonl`. They distinguish execution, selected/deferred/excluded candidates, unresolved completed results, intermediate stage evidence, context capability gaps, purpose, and observed usage. A drained queue is not exhaustive vulnerability coverage. Task events and all accepted artifacts remain available. Back up a stopped run after SQLite checkpoints; do not copy a live main database without its WAL.

## Review Coverage Benchmark

```sh
node Jeeves/dist/src/cli.js review-benchmark --run Jeeves/runs/review-001 \
  --benchmark Jeeves/benchmarks/juice-shop-20.2.0.json
```

This optional evaluator is local and read-only with respect to source and task state. It requires the specified repository revision and case file hashes, writes `reports/benchmark.json`, and makes no model calls. Expected labels are never passed to investigation agents. The bundled benchmark is a small source-review obligation set, not a complete list of Juice Shop vulnerabilities or executable reproductions. Historical/unverified cases are separate; the escaped-review-text negative case must not be confused with product-description HTML.

Selection recall, investigation coverage, supported conclusions and potential false-positive flags are separate. Detection is unmeasured before inference. Precision requires independent adjudication of all distinct reports and is not fabricated from this small case list. Dependency versions remain inventory until supported by a reviewed applicable advisory; automatic advisory fetching, runtime exploit validation and complete interprocedural proof are not provided. Held-out repository and live quality evaluation remain release gates.

## C# And Azure Capability Boundaries

| Capability | Implemented Behavior |
| --- | --- |
| TS/JS syntax | Isolated parser worker, bounded file/result sizes, call and callback/registration candidates |
| TS/JS semantics | Lazy real-project TypeScript programs; aliases/signatures to candidate source declarations; paginated project-scoped reverse callers; local symbol/assignment evidence; missing dependencies and dynamic dispatch remain partial |
| C# syntax | Roslyn calls, methods, comment trivia and exact syntax spans |
| C# semantics | Bounded declarative project source loading with framework-core references; local candidate targets, operand definitions and isolated-file control-flow blocks |
| C# project limitations | No MSBuild evaluation, external package/reference resolution, multi-target build conditions, generators, or complete virtual/interface dispatch modeling |
| Azure/Node evidence | Import-linked SDK invocations, Functions bindings and declared ARM JSON resources |
| .NET framework evidence | Trigger/route/authorization attribute candidates with explicit identity/runtime limitations |
| Deployment limits | No live Azure inspection, Bicep/Terraform evaluation, APIM policy execution, or proof that declared configuration matches deployed state |
| Cross-service analysis | Agents can retrieve source/configuration; automatic verified RPC/message-field graph stitching is not implemented |

An SDK import, attribute, method name, or model assertion is not proof of runtime invocation, trust, authorization or dataflow. Full interprocedural taint analysis is outside this implementation.

## Large-Repository Behavior

- Stream input arrays/JSONL rather than loading entire classification datasets.
- Keep source/artifact bodies out of navigation rows; the separate local search index stores bounded comment-masked chunks with original offsets.
- Use stable generation-bound keyset pages for high-fan-out call searches.
- Share one lazy TS semantic worker across agents, coalesce identical requests, bound the pending queue, evict idle workspaces and kill timed-out workers.
- Limit syntax-worker heap and request time. Compiler heap limits are enforced; RSS checks are soft/post-request checks, not a full OS process-tree memory guarantee.
- C# uses one serialized sidecar with a GC heap limit and request deadline. TS and C# do not yet share a global memory reservation scheduler.
- A changed snapshot gets a new generation; semantic results are keyed by snapshot/configuration/compiler identity. Use `index --run NEW_RUN --reuse-run PREVIOUS_RUN` to reuse unchanged, hash-matched syntax records under the same index implementation version. Changed source is reparsed; all project configurations are rediscovered. Semantic results are conservatively invalidated for a new snapshot. Fine-grained semantic dependency reuse is not yet implemented.
- Oversized or unavailable analysis reports gaps. It does not claim no callers or safety.

Measured on macOS arm64 / Node 26.8.2: 100,000 synthetic caller records were inserted and paged exactly once in about 1.25 seconds, with about 174 MiB peak RSS in the main/database-worker process. This is a navigation-store benchmark, not a claim about whole-repository compiler memory, model latency, or security accuracy.

## Approved Local Validation

Supply a JSON plan with `taskId`, `snapshotId`, a digest-pinned Docker `image`, a `command` argument array, `timeoutMs`, `memoryMb`, and `expectedObservation`. Review its image and command before approval. The plan must reference an existing task and matching snapshot.

```sh
node Jeeves/dist/src/cli.js validate --run Jeeves/runs/review-001 \
  --validation-plan /absolute/path/to/reviewed-plan.json --approve-execution

node Jeeves/dist/src/cli.js validate --run Jeeves/runs/review-001 --approval APPROVAL_ID
```

Approval is bound to the plan hash and expires after one hour. The container runs non-root, without network, capabilities, host credentials or a writable source mount. Source is reverified before staging. Image pulling is disabled. CPU, memory, PID, output and timeout limits apply. `/work` is an ephemeral writable filesystem and `/snapshot` contains the read-only source; the reviewed command may copy needed files into `/work`.

The Docker daemon was unavailable during initial development, so execution was not live-tested. Argument-policy tests pass and the command fails closed when Docker is unavailable. Do not treat this as a tested hostile-code isolation boundary until environment-level sandbox tests pass. No public or production resources should be used.

## Verification Commands

```sh
npm run test:all --prefix Jeeves
npm run check --prefix Jeeves
npm run benchmark --prefix Jeeves -- 100000
npm run test:live --prefix Jeeves
npm run test:workflow-live --prefix Jeeves
```

The last two commands make billable model calls using synthetic data only. The normal test suite is offline. Tests cover traversal/symlink rejection, dataset integrity/replay, SQLite rollback, task fencing/budgets, source citations, syntax/semantic navigation, C# integration, model permissions, scale paging, compiler backpressure and sandbox argument policy.

The roadmap in `plan.md` remains applicable. Before treating Jeeves as production-ready, complete the remaining framework, cross-service, incremental reuse, exact provider billing reconciliation, sandbox and held-out quality gates; model agreement is not a substitute for them.