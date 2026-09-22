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
node Jeeves/dist/src/cli.js plan --run Jeeves/runs/review-001 --max-operations 25
node Jeeves/dist/src/cli.js status --run Jeeves/runs/review-001
```

The importer accepts the version-1 dataset manifest used by the existing classifier: `dataset.json`, its checksummed `inventory.json`, rubric snapshot, function JSONL, and classification JSON array. Manifest filenames are used instead of hardcoding a target. It validates file sizes/hashes, source spans, sanitized hashes, answer labels/distributions and counts. Partial imports can be replayed idempotently; a different dataset requires a new run directory.

Imports snapshot the classified source, additional TS/JS/C# source, selected project/configuration files, and README/security/contribution documents. Additional source is reported separately and is not treated as Jev-classified. Environment files, installed dependencies, build output and escaping symlinks are not copied. Relevant configuration can contain literal secrets; review the source-disclosure policy before a live run. A snapshot makes the input stable but does not make it public or safe to transmit. Imported sanitized implementations are independently checked against parser-based comment masking, rather than trusting their hashes alone.

The index stores syntactic call and registration candidates, checkpointed by completed file. Interrupted generations replay only incomplete files. Semantic programs are loaded only when a tool explicitly requests a project context. A name-based reverse lookup is deliberately labeled incomplete. The additional `find_semantic_callers` tool follows compiler-resolved targets within one selected TS/JS or C# project and pages its progress; other projects, dynamic dispatch and external consumers remain explicit gaps. `trace_local_value` returns operand declarations, parameter boundaries, candidate writes and enclosing conditions, not a path-sensitive taint proof.

Triage uses explicit operation/influence combinations and a reproducible control sample, not an aggregate vulnerability score. A maximum-25 plan currently selects at most one theme per function, reserves about 20% for controls, and keeps code-purpose labels. Localization deduplication across different parent/callback tasks is not yet implemented; inspect repeated operation spans in reports.

## Live Investigation

```sh
node Jeeves/dist/src/cli.js run \
  --run Jeeves/runs/review-001 \
  --model gpt-5-mini \
  --workers 2 \
  --config Jeeves/config/defaults.json \
  --allow-live

node Jeeves/dist/src/cli.js report --run Jeeves/runs/review-001
```

Choose an available model explicitly. `--allow-live` authorizes transmission of selected source, classifications, and retrieved evidence to the configured GitHub Copilot service. Jeeves does not silently switch models or providers. Azure-hosted custom providers are not wired in this version.

Each operation progresses through isolated localizer, investigator and challenger sessions unless an earlier result refutes the hypothesis or finds no relevant operation. Tools enforce source membership, bounded spans, comment masking, evidence citations and AST operation locations. The model cannot call shell, arbitrary URL, write, MCP or agent-spawning tools. Unknown permissions fail closed. Runtime configuration discovery, repository instructions and persistent memory are disabled.

Investigation agents cannot mark a finding as locally reproduced. They submit `needs_context`, `supported_candidate`, `refuted_hypothesis`, `no_relevant_operation` or `budget_exhausted`. The validation executor records raw observations separately and requires review.

Default limits include 75 role-session calls per run, 20 observed provider requests per session, 40 tool calls per attempt and a 120-second model deadline. SDK usage events are recorded without prompt content; absent token fields remain unknown. Session-call counts and provider cost multipliers are not currency totals. An optional `maxAiCreditsPerSession` uses the SDK's provider-side limit when supported. The observed request guard aborts when its boundary event arrives and is not a prebilling exactly-once guarantee; retain provider/account quotas. Authentication, billing and rate-limit errors stop further task admission. Exhausted work remains queued or failed, and the CLI exits nonzero when tasks are not completed.

## Persistence And Recovery

`runs/<run>/state.sqlite` is the canonical WAL-backed metadata, task, lease and event store. Database requests run in a bounded worker, use parameterized values, and never hold a transaction during a model call. Content-addressed JSON artifacts contain source records, requests, evidence and accepted results. Source snapshots are read-only.

Every result is bound to task, attempt, role, source hashes, model identity and prompt version. Stale attempts cannot accept results after a task is reclaimed. Successful task stages are not repeated on resume.

```sh
node Jeeves/dist/src/cli.js resume \
  --run Jeeves/runs/review-001 --model gpt-5-mini --allow-live --retry-failed
```

Explicit `--retry-failed` retries a failed role only while it has fewer than three recorded attempts. Expired running leases are fenced and requeued. Run-level call usage is retained. To recover a stale coordinator lock, use `resume --run ... --recover-lock`; it refuses when the recorded owner process is alive. Do not manually delete a live lock.

Reports are streamed to `reports/investigations.json`, `reports/summary.md`, and `reports/coverage.json`. They include unresolved/failed tasks and capability caveats. Task events and all accepted stage artifacts remain in SQLite/artifact storage even though the summary shows the most recent result. Back up a stopped run after SQLite checkpoints; do not copy a live main database file without its WAL.

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
- Keep source/artifact bodies out of the SQLite navigation indexes.
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