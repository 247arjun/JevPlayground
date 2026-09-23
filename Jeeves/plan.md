# Jeeves Implementation Plan

Status: design only. No implementation, dependency installation, model calls, or target analysis is authorized by this document alone.

Implementation note: a first working implementation now exists under this folder following separate user authorization. See `README.md` for executable commands, measured checks, and capability limitations. The stages and acceptance criteria below remain the intended destination, not a claim that all release gates have passed.

Coverage revision: full candidate discovery and full declared-scope review now replace pilot-sized defaults. Sampling is an explicit experiment mode, not a whole-repository assessment. The implementation adds a persisted candidate catalogue, non-function subjects, templates/configuration evidence, indexed scoped search, reviewed follow-ups, and cumulative operator-approved run budgets. Existing Jev answers are reused; changed snapshot/planner/prompt policies require fresh runs. See the README for current commands and the version-pinned source-review benchmark. No live recall, precision, hostile-code sandbox or complete semantic-coverage guarantee follows from offline tests or queue completion.

## 1. Objective

Build a classification-guided, multi-agent security investigation system for C# and TypeScript/JavaScript services, with Azure-aware framework and deployment analysis.

Jeeves consumes an existing per-function Jev classification dataset. It selects concrete operations for investigation, retrieves relevant source and configuration, maintains an evidence ledger, challenges hypotheses, and optionally validates supported candidates in an isolated environment.

The system must answer more useful questions than whether a function is generally suspicious:

- Which particular operation merits review, and which operand or state is relevant?
- Who can influence that operand, through which observed or modeled relationships?
- What guards and external enforcement apply to this operation on the path being considered?
- Which security invariant might be violated, under what preconditions?
- What counterevidence exists, and which questions remain unresolved?
- What was actually tested, as distinct from inferred by a model?

The result is an auditable investigation dataset and a review report, not a promise of exhaustive vulnerability detection.

### Scope

- Languages: TypeScript, JavaScript running on Node.js, and C#.
- Frameworks: ASP.NET Core, Express initially, Azure Functions for .NET and Node.js; other Node frameworks are later adapters.
- Azure surfaces: identity/Entra ID, Key Vault, Blob Storage, Azure SQL/Cosmos DB, HTTP/API Management, and messaging triggers/clients.
- Default operation: local CLI, one orchestrator, bounded concurrent agent and compiler workers, local SQLite metadata/indexes, and immutable file artifacts.
- Input: immutable repository snapshot plus a versioned classification dataset; no hardcoded target repository names or paths.
- Output: operations, investigation records, evidence relationships, dispositions, validation records, and coverage.

### Non-Goals For The First Release

- Replacing a full static analyzer, proving all execution paths, or constructing a complete runtime call graph.
- Automatically treating Jev labels or reasoning-model agreement as verified vulnerabilities.
- Autonomous remediation, commits, pull requests, deployment changes, or public vulnerability reports.
- Testing third-party/public deployments.
- Requiring a hosted database, vector database, graph database, Kubernetes, or a distributed queue.
- Reclassifying every function when valid classification artifacts already exist.
- Supporting arbitrary languages or reconstructing undeclared distributed systems from naming similarities.

## 2. SDK Decision And Compatibility Gate

Use **GitHub Copilot SDK for Node.js/TypeScript, `@github/copilot-sdk`**, as confirmed during planning.

The originally supplied Microsoft repository, `microsoft/Agents-M365Copilot`, contains the **Microsoft 365 Copilot APIs client libraries**. It is not the tool-using coding-agent runtime used in this design. Do not add that dependency or require an M365 tenant/license merely because of the original link.

The GitHub Copilot SDK provides programmatic sessions backed by the Copilot runtime. Jeeves owns task scheduling, permissions, evidence, budgets, persistence, and the meaning of completion. SDK session history is not the source of truth for investigation state.

The following API surfaces were documented when this plan was written; verify them against a pinned published SDK/runtime pair in Stage 0 rather than assuming the repository's main branch matches the installed release:

| Documented SDK Surface | Planned Use |
| --- | --- |
| `CopilotClient`, `start`, `stop` | Start and cleanly terminate the controlled runtime connection |
| `createSession`, `resumeSession` | Independent sessions for roles and operation-specific work |
| `defineTool`, schema-based parameters | Register Jeeves-owned retrieval and result-submission tools |
| `send`, `sendAndWait`, session events | Dispatch work and correlate results to the correct attempt |
| `onPermissionRequest`, tool availability controls | Deny all capabilities except explicitly scoped tools |
| `abort`, session cleanup/disconnect | Cancel timed-out work and release resources |
| Model discovery and session model configuration | Validate available model capabilities instead of assuming a model name |
| Custom provider configuration | Optional Azure-hosted model route after compatibility and auth testing |

### Release Gate

Before implementing the agent workflow, prove with a small fixture that the selected release supports:

1. Two isolated sessions without cross-session evidence or memory leakage.
2. One custom read-only tool with strict input validation.
3. Denial of shell execution, arbitrary file reads/writes, external URL fetching, unapproved MCP servers, and unknown permission requests.
4. A schema-validated terminal result correlated to the correct task attempt.
5. Cancellation that stops outstanding work, not merely the caller waiting for it.
6. Observable errors, bounded retries, cleanup, and a tested policy for session resume.
7. The selected authentication and hosting mode under the intended organization policy.

A timeout from `sendAndWait` must not be treated as cancellation of the runtime. Explicitly abort, await bounded cleanup, and fence late results from the expired attempt.

Native structured-output support may be version/model dependent. Prefer it when the pinned pair supports it. Otherwise use a schema-validated `submit_result` custom tool; a bounded JSON parsing/repair path can be a compatibility fallback. Never accept arbitrary prose as a completed task or execute model-proposed commands to repair output.

Authentication and provider choices are separate from the Azure resources under investigation. A service running on Azure does not require Jeeves itself to run on Azure. Do not assume a managed identity can authenticate to GitHub Copilot or that an Azure provider accepts the same credentials as the default provider.

## 3. Architecture

```text
CLI and run configuration
        |
        v
Baseline verifier -> streamed classification catalog in SQLite
  |                         |
  v                         v
Lightweight repository index -> deterministic candidate planner
                                  |
                                  v
                     Single-writer orchestrator
                       |        |        |
                       v        v        v
                   Localizer Investigator Challenger
                       \        |        /
                        Copilot SDK sessions
                                  |
                             Scoped tool gateway
                                |
                           Shared navigation service
                           /          |           \
                       SQLite index   Workspace manager   Framework/Azure models
                                |
                           Bounded compiler pool
                           TS/JS workers / Roslyn sidecars
                                |
                           Snapshot/evidence repository
                                  |
                       Optional validation approval
                                  |
                         Isolated test executor
                                  |
                      Reports and coverage artifacts
```

The arrows represent responsibilities and requests, not permission to execute arbitrary code. Agent tools go through the gateway. Models cannot directly mutate the source repository, canonical task state, or evidence ledger.

### Implementation Choices

- One Node.js/TypeScript application under `Jeeves/`, with a separate .NET analysis sidecar in the same tree.
- Use an actively supported Node.js LTS and a pinned .NET LTS SDK; confirm the chosen Copilot runtime and target-project tooling support them. Record exact versions in the run manifest.
- Use TypeScript strict mode and one package lockfile for the Node application. Centralize .NET package versions and lock restored dependencies.
- Use runtime schemas for tool arguments, task results, artifact records, and the sidecar protocol. TypeScript type annotations alone do not validate model output.
- Keep compiler services in isolated, bounded worker processes. No agent creates its own compiler workspace, and no process retains the entire repository's syntax trees by default.
- Use local SQLite from the first operational release for navigation indexes, classification lookup, tasks, leases, evidence references and event metadata. Keep large source snapshots, prompts, results and validation artifacts in files. No database server is required.
- Build a lightweight repository-wide syntax/candidate index, then use compiler/symbol resolution lazily for selected project contexts. Bounded lexical search is a fallback and produces candidate relationships, not verified call edges.
- Keep tests deterministic and offline by default. Live model tests are explicit, separately budgeted commands.

### Large-Repository Design Invariants

- Repository discovery and lightweight indexing may take work proportional to input size; an individual lookup must not repeatedly parse or deserialize the entire repository.
- Peak working memory is bounded by configured in-flight batches, result pages, compiler workspaces and model contexts, not by the number of queued investigations.
- Never create one artificial compiler project from all discovered files. Respect real project references, dependency closures, target frameworks and conditional compilation.
- Syntax coverage, semantic coverage and investigation coverage are separate, measurable quantities. Discovering every file does not mean every project has been type-checked or every operation investigated.
- All expensive requests pass through admission control. No unbounded worker queue, eager background type-check of every project, or unlimited expansion of callers is permitted.
- Index and evidence reuse must preserve snapshot/configuration identity. Cache hits from incompatible project contexts are incorrect even when the file text matches.
- These guarantees are release prerequisites, not a future scale-out enhancement. Tree-sitter is not required to implement them.

## 4. Proposed Code Structure

This is the intended ownership layout, not a requirement to create every file in the first commit. Add files as their implementation stage needs them. `Jeeves` is the workspace folder; `jeeves` is the package and CLI name.

```text
Jeeves/
  plan.md
  README.md
  package.json
  package-lock.json
  tsconfig.json
  eslint.config.mjs
  .gitignore
  config/
    defaults.json
    profiles/
      node-azure.json
      dotnet-azure.json
      mixed-azure.json
  src/
    cli/
      main.ts
      commands/
        doctor.ts
        import.ts
        index.ts
        plan.ts
        run.ts
        resume.ts
        status.ts
        validate.ts
        report.ts
    domain/
      run.ts
      source.ts
      classification.ts
      operation.ts
      evidence.ts
      graph.ts
      investigation.ts
      task.ts
      validation.ts
      schemas.ts
    datasets/
      load-manifest.ts
      import-jev.ts
      stream-records.ts
      verify-artifacts.ts
      normalize-records.ts
      migrations.ts
    snapshots/
      capture.ts
      verify-source.ts
      source-locations.ts
      path-policy.ts
    analysis/
      adapter.ts
      capabilities.ts
      index-manager.ts
      project-catalog.ts
      syntax-indexer.ts
      index-generations.ts
      dependency-index.ts
      invalidation.ts
      navigation-service.ts
      workspace-manager.ts
      compiler-pool.ts
      admission-control.ts
      request-coalescer.ts
      pagination.ts
      query-coverage.ts
      local-flow.ts
      tsjs/
        project-loader.ts
        function-map.ts
        calls.ts
        references.ts
        definitions.ts
        control-flow.ts
        worker.ts
      csharp/
        client.ts
        protocol.ts
        mapping.ts
      search/
        scoped-search.ts
        result-verifier.ts
    models/
      registry.ts
      schema.ts
      node/
        express.ts
        azure-functions.ts
      dotnet/
        aspnet-core.ts
        azure-functions.ts
      azure/
        identity.ts
        key-vault.ts
        blob-storage.ts
        data-services.ts
        messaging.ts
        apim.ts
        infrastructure.ts
        optional-live-reader.ts
    triage/
      rule-schema.ts
      rules.ts
      candidate-planner.ts
      sampling.ts
      deduplicate.ts
    agents/
      roles.ts
      task-context.ts
      result-validator.ts
      localizer.ts
      investigator.ts
      challenger.ts
      validation-planner.ts
    prompts/
      common.md
      localize.md
      investigate.md
      challenge.md
      plan-validation.md
    copilot/
      client.ts
      capabilities.ts
      auth.ts
      provider-config.ts
      session-pool.ts
      permissions.ts
      events.ts
      structured-results.ts
    tools/
      registry.ts
      gateway.ts
      read-source.ts
      locate-operation.ts
      resolve-call.ts
      find-callers.ts
      trace-local-value.ts
      inspect-guard.ts
      inspect-registration.ts
      read-contract.ts
      inspect-deployment.ts
      submit-result.ts
    orchestration/
      coordinator.ts
      scheduler.ts
      state-machine.ts
      worklist.ts
      leases.ts
      budgets.ts
      retries.ts
      recovery.ts
    evidence/
      ledger.ts
      claims.ts
      citations.ts
      relationships.ts
      context-builder.ts
      cache.ts
    storage/
      metadata-store.ts
      sqlite-store.ts
      sqlite-migrations/
      index-repository.ts
      task-repository.ts
      query-plans.ts
      artifact-store.ts
      file-store.ts
      atomic-write.ts
      event-journal.ts
      manifests.ts
    validation/
      policy.ts
      approval.ts
      sandbox.ts
      executor.ts
      result-checker.ts
    reporting/
      report-model.ts
      markdown.ts
      json.ts
      sarif.ts
      coverage.ts
      metrics.ts
  dotnet/
    global.json
    Directory.Packages.props
    Jeeves.Analysis.sln
    Jeeves.AnalysisHost/
      Jeeves.AnalysisHost.csproj
      Program.cs
      Protocol/
      Workspace/
      Symbols/
      Operations/
      ControlFlow/
      Frameworks/
    Jeeves.AnalysisHost.Tests/
      Jeeves.AnalysisHost.Tests.csproj
      ProtocolTests.cs
      ResolutionTests.cs
      FlowTests.cs
  tests/
    unit/
    contract/
    integration/
    recovery/
    scale/
      corpus-generator.ts
      project-loading.test.ts
      paging.test.ts
      memory-pressure.test.ts
      incremental-invalidation.test.ts
      restart.test.ts
      benchmark.ts
      acceptance-profile.json
    security/
    evaluation/
    fixtures/
      tsjs/
      csharp/
      azure/
      mixed-language/
  runs/                         # Ignored, protected local artifacts
  .cache/                       # Ignored, versioned derived indexes/artifacts; no serialized compiler objects
```

### Dependency Boundaries

| Area | Owns | Must Not Own |
| --- | --- | --- |
| `domain` | Versioned records and validation contracts | SDK sessions, filesystem side effects |
| `datasets` / `snapshots` | Import integrity and immutable source identity | Security conclusions |
| `analysis` | Candidate indexes, shared compiler pool, project admission, bounded navigation and query coverage | Agent-owned compiler instances or authoritative vulnerability verdicts |
| `models` | Versioned framework/API relationships and deployment facts | Unreviewed model-generated guarantees |
| `triage` | Explicit selection rules and reproducible control samples | Model execution or final risk scoring |
| `agents` | Role-specific prompts, structured proposals and rebuttals | Task scheduling or unchecked tool execution |
| `copilot` | SDK lifecycle, provider/auth compatibility and event correlation | Evidence truth or task-completion policy |
| `tools` | Scoped requests and validated responses | Arbitrary shell access |
| `orchestration` | Task transitions, budgets, attempts and recovery | Language-specific semantic rules |
| `storage` | Transactional SQLite metadata, paginated indexes, immutable artifacts and recovery | Interpretation of model answers or unbounded in-memory result loading |
| `validation` | Approved isolated experiments and measured outcomes | Production testing or autonomous deployment |
| `reporting` | Presentation of validated records and coverage | Generating unsupported findings |

Keep source-reading and analysis contracts independent of the Copilot SDK so they can be tested without model access. Do not introduce a generic multi-provider orchestration framework beyond the small adapter needed for SDK isolation and fake-model tests.

## 5. Configuration And Command Surface

Proposed commands, to be implemented rather than run during planning:

```text
jeeves doctor --config <config-file>
jeeves import --dataset <dataset-directory> --repo <source-root> --run <run-directory>
jeeves index --run <run-directory> --languages tsjs,csharp
jeeves index --run <run-directory> --semantic-project <project-context-id>
jeeves plan --run <run-directory> --profile <review-profile> --max-operations 25
jeeves run --run <run-directory> --workers 2
jeeves status --run <run-directory>
jeeves resume --run <run-directory>
jeeves validate --run <run-directory> --investigation <id> --approval <approval-id>
jeeves report --run <run-directory> --format json,markdown
jeeves benchmark --config <config-file> --profile <scale-profile>
```

`import`, `index`, `plan`, `status`, and deterministic report generation must work without a model credential. Semantic indexing may require an approved sandbox/toolchain, but must not silently restore or build an untrusted target on the host.

By default `index` performs lightweight discovery and syntax indexing only. `--semantic-project` is explicit optional warm-up, subject to the same resource and isolation limits as on-demand requests. `--workers` controls reasoning concurrency; compiler concurrency has its own configuration and must not rise automatically with the agent count.

Configuration includes:

- Source snapshot, classification dataset, project configurations, and output root.
- Classification schema/rubric mappings, included languages, code-purpose groups, and exclusion policy.
- Copilot provider, model capabilities, SDK/runtime versions, and credential acquisition mode.
- Worker count, model-call ceiling, retrieval/byte/token ceilings, deadlines, retries, and cost policy.
- Independent syntax/compiler worker counts; process-tree memory budget; maximum resident and concurrently loading workspaces; per-load and per-query deadlines; pending-request queue limits.
- Project-context allowlists, maximum dependency-expansion work, idle-eviction policy, oversized-project behavior, and sandbox runtime memory enforcement.
- Import/index batch rows and bytes, maximum source-file size, SQLite page-cache limits, query page rows/bytes, cursor lifetime, disk/artifact quotas, and index-retention policy.
- Caller/graph expansion budgets, per-project fairness, control-sample seed, and benchmark acceptance-profile path.
- Per-role tool allowlists and model-context policy.
- Framework/API-model versions and enabled Azure evidence readers.
- Evidence retention, redaction, encryption requirements, and report publication policy.
- Sandbox image digests, dependency sources, approval requirements, and network policy.

Never place credentials in a committed configuration file. Store references to environment variables, secure credential stores, or approved token providers. Record configuration hashes in the run, excluding secrets.

## 6. Import And Source Identity

### Dataset Contract

Accept a generic Jev dataset directory containing a manifest, rubric snapshot, per-function classifications, source inventory, and coverage metadata. Support the currently used artifact shapes through an importer rather than importing another analysis workspace's implementation.

- Stream classification JSON arrays/JSONL and source manifests with a maintained parser. Insert normalized records into SQLite in transactions bounded by both row count and bytes; do not call whole-file `JSON.parse` on a large dataset or retain all source bodies in a map.
- Checkpoint import progress by artifact identity and committed record/batch sequence. For JSON arrays, safely replay the stream on resume when the parser cannot resume at a record boundary; unique record keys prevent duplicate accepted rows. Do not seek into arbitrary JSON bytes.
- Keep bulk source text and original model responses in content-addressed files or bounded shards; metadata stores only identifiers, hashes, ranges and artifact references. Store classification answers in queryable rows keyed by function/question, not only inside an opaque JSON document.
- Validate the artifact schema, checksums, expected question keys, per-question labels, model identifiers, and record uniqueness.
- Verify classified function hashes against inventory records and the current source snapshot.
- Preserve raw Jev answers, confidence, probabilities, question hash, model, sanitizer metadata, and source coordinates.
- Recognize operation-first and historical defect schemas as distinct input modes. Do not translate `present` into `local_defect`.
- Do not hardcode the number of questions. A profile maps supported dimensions and reports unsupported ones.
- Unknown/missing classifications remain coverage gaps, not negative answers.

### Identity And Coordinates

- Define `snapshotId` from repository identity, revision, selected source/configuration manifest, and dirty/untracked source policy.
- Preserve imported function IDs as external IDs; use a namespaced internal ID that includes snapshot and language/project context.
- Match function implementations using relative path, source range, and original hash. Never join only on a function name.
- Make offset encoding explicit. Existing TS/JS snapshots may use UTF-16 offsets; sidecars may use UTF-16 spans or byte positions. Convert through a tested source-location service.
- Store start-inclusive/end-exclusive ranges, one-based display lines/columns, newline encoding, original file hash, and sanitized-content hash.
- Keep generated-source provenance, preprocessing symbols, target framework, and compilation configuration as part of C# interpretation identity.
- When one file is included in multiple projects, keep the project interpretations separate. A classification span may map to several semantic contexts.
- Detect new, deleted, modified, and unclassified files. A matching Git commit alone is not enough for a dirty working tree.

Prefer a read-only snapshot under the run's controlled input area. Preserve the selected source and relevant configuration, without executing Git hooks, submodule updates, LFS hooks, package scripts, or arbitrary target tools. Record omitted submodules/generated sources explicitly.

## 7. Language Adapter Contracts

Expose typed requests through one common interface, with implementations in TypeScript and the .NET sidecar:

| Request | Result |
| --- | --- |
| `describeCapabilities` | Supported languages, project states, semantic features and limitations |
| `locateImplementation` | Function candidates matching a snapshot span and hash |
| `locateOperation` | AST/operation nodes for a proposed expression range |
| `resolveCall` | Candidate implementation targets, declaration-only boundaries and resolution evidence |
| `findCallers` | Paginated candidate call sites, argument mapping, searched project scopes and unresolved dispatch notes |
| `findDefinitions` | Locally reaching definitions or candidate property writes, with branch context |
| `traceLocalValue` | Bounded value relationships, transformations and explicit stopping points |
| `inspectGuards` | Conditions and relevant operation relationships, without a blanket safety verdict |
| `inspectRegistration` | Handler/delegate/callback/DI relationships and registration provenance |
| `searchScoped` | Bounded lexical candidates when semantic resolution is unavailable |

Each response carries `snapshotId`, project/configuration ID, adapter version, evidence references, completeness status, unresolved reasons, truncation markers, and candidate-target identity. Collection responses also carry an index-generation-bound continuation cursor, returned rows/bytes, searched scopes, unsearched candidate scopes, and whether totals are exact or only known lower bounds. Use deterministic evidence categories such as `syntactic`, `compiler_resolved_candidate`, `framework_modeled`, and `model_proposed`; do not invent numeric certainty for compiler results.

### Two-Level Index And Query Pipeline

#### Level 1: Lightweight Repository Index

1. Stream discovery of eligible files, imported classifications and project/configuration files. Record excluded, unreadable, oversized and parse-error files with reasons.
2. Parse a bounded number of files at a time using the language syntax APIs; emit records and release syntax trees after the batch commits. A very large file still needs its own size/time/memory gate.
3. Persist file/function ranges and hashes, syntactic imports/exports, call/new sites, declaration names, callback positions, obvious registrations and project-membership candidates.
4. Discover the project graph from TypeScript configuration/references and C# solution/project declarations. Where configuration evaluation requires execution or unavailable settings, record provisional membership until an approved semantic load establishes it.
5. Keep unresolved computed calls, dynamic imports, reflective sites and ambiguous project membership as searchable records. A name-based candidate index alone cannot claim to enumerate every possible caller.
6. Flush bounded batches to SQLite and record progress. Publish a completed index generation only when its covered input manifest verifies; queries against a partial generation must identify the incomplete scopes.
7. Use this index for navigation candidates and triage across the whole declared repository scope without retaining every compiler program in memory.

Level 1 is not a semantic call graph. It keeps enough location and module/registration evidence to choose which semantic contexts to open next. External consumers, unsupported runtime registration and undiscovered build products remain explicit boundaries.

#### Level 2: Lazy Project Semantics

1. A semantic request identifies the operation or symbol, project-context candidates and the fact being sought.
2. Check a derived-result cache keyed by request, snapshot, project/dependency fingerprint and analysis version.
3. Use Level 1 and project references to identify candidate caller/implementation projects. Do not search only the callee's defining project when dependents can contain callers.
4. Ask the shared workspace manager to acquire the needed TypeScript program or Roslyn project context, including the dependency closure necessary for correct interpretation.
5. Resolve and validate one bounded page of candidate relationships. Persist derived relationships and their evidence, not raw compiler objects.
6. Return results with the remaining scopes/cursor. Load additional project contexts only when requested or admitted by an explicit warm-up policy.
7. Release the workspace lease. Keep it warm only within the resident-memory budget; otherwise evict it or recycle the worker process.

Do not run an emit/full application build just to answer a symbol lookup. Conversely, do not claim that analyzing a few independent files is equivalent to a compiler program when dependency context is required. Metadata-only references are acceptable only when the adapter records what implementation evidence is unavailable and can navigate to source separately.

### Shared Workspace Manager

Use a central manager for both language backends; sessions receive tools, not compiler instances.

- Key workspace identities by language, project/target configuration, source/dependency fingerprint, compiler version and sandbox/toolchain policy.
- Track lifecycle states such as `unloaded`, `loading`, `ready`, `busy`, `evicting` and `unavailable`, with leases and request IDs.
- Coalesce concurrent requests for the same workspace load or semantic lookup. One cold load serves multiple waiting investigations.
- Separate reasoning, syntax and semantic queues. Bound each queue; apply fair scheduling across investigations and project contexts so one high-fan-out task cannot consume the pool.
- Admit loads only when worker-count and memory reservations fit. Refine reservations from measured workspace high-water marks; stop new admissions under pressure.
- Measure the compiler process tree's RSS, not just the Node heap. Enforce hard runtime/container limits where available, plus soft admission thresholds and supervisor cancellation. Without a verified hard-limit facility, advertise soft-limit enforcement rather than a hard guarantee.
- Pin a workspace only while a query lease is active. Evict idle workspaces with a cost-aware LRU policy; recycle workers when disposing compiler state does not release sufficient memory.
- An agent cancellation removes its waiter, not another investigation's shared load. Cancel shared work only when no authorized waiters remain or its own resource deadline expires.
- Bound stdout/stderr and sidecar protocol frames. Stream large result pages; never send an entire solution index through one RPC response.
- On worker failure, preserve committed index/evidence records, fence incomplete requests, and release reservations. Do not restart the same oversized workspace indefinitely.

If one valid project and its dependencies exceed the available budget, return `resource_limited` with the project, requested capability and unmet requirement. Continue syntax-only work with an explicit downgrade, or require operator approval for a larger local/remote worker. Do not silently divide that project into semantically inequivalent fragments, change compilation settings, or omit dependencies while claiming full resolution.

### Bounded Navigation Algorithm

```text
ON navigation request:
  validate snapshot, project context, page size, cursor and deadline
  read a bounded candidate page from the persisted index
  include unresolved sites and project-scope gaps in the coverage envelope
  return a matching cached semantic result when its dependencies are current

  FOR each required project admitted within the request budget:
    join an existing workspace lease or enqueue one shared load
    apply backpressure if worker, memory or queue reservations do not fit
    resolve candidates under a per-query deadline
    persist verified relationships and explicit unresolved outcomes
    release the lease

  return a bounded result page, evidence references and continuation cursor
  distinguish exhausted searched scope from unresolved/unsearched scopes
```

### High-Fan-Out Queries And Coverage

- Use keyset pagination with a deterministic ordering, for example project context, relative path, source offset and stable record ID. Bind cursors to the query fingerprint and immutable index generation; reject stale or foreign cursors.
- Cap both page rows and serialized bytes. Do not compute an expensive exact total merely to display pagination; return a lower bound or unknown total when appropriate.
- Partition callers by project/entry-point context and then by call-site/argument pattern where evidence supports that grouping. Store grouping criteria, member counts and selected members.
- Representative sampling is allowed for prioritization, but cannot establish safety for omitted callers. Reports must identify the sampled and unexamined population.
- Keep a visited set keyed by operation/value, project and path context. Reuse shared graph edges, represent cycles, and materialize only bounded display paths instead of all root-to-sink combinations.
- Maintain separate dimensions for query completion (`complete_for_scope`, `partial`, `blocked`) and semantic capability (`syntax_only`, `semantic_partial`, `semantic_available`). Attach reason codes such as `unresolved_dispatch`, `missing_dependency`, `unsearched_project`, `page_budget`, `timeout` and `resource_limited`.
- An empty page with unresolved or unsearched scopes is not evidence of no callers. Even a complete result is complete only under its recorded scope, adapter/model capabilities and runtime assumptions.

### Incremental Reuse And Invalidation

An imported snapshot is immutable. Refresh creates a new snapshot/index generation; never mutate the source identity under an existing finding.

| Change | Required Invalidation |
| --- | --- |
| Source body edit | Changed file's syntax records, owning semantic contexts, local-flow evidence and dependent investigations; reuse unaffected artifacts only after fingerprint checks |
| Export/signature or shared interface edit | Defining context and affected reverse dependency/caller contexts |
| Project configuration, compile symbols, target framework or resolution settings | All contexts and relationships interpreted under that configuration |
| Package lock, reference assembly or generated-source change | Semantic contexts consuming that dependency; source-generation provenance and downstream evidence |
| Framework/API model or adapter update | Derived relationships and findings that depend on the changed model/analysis version |
| Jev rubric, triage rule, reasoning prompt or model change | Corresponding classifications/selections/conclusions; do not rebuild unchanged syntax indexes unnecessarily |
| Evidence/permission policy change | Affected cached views and conclusions; never reuse previously accessible sensitive context under a stricter policy |

Persist a dependency index from artifacts and derived records to their inputs. A change invalidates the transitive dependent evidence, not just the edited file. When the changed public surface or dependency effects cannot be established safely, invalidate the affected project/dependency closure conservatively rather than serving stale semantic results.

Never serialize TypeScript/Roslyn runtime objects for reuse across versions. Persist portable derived records with schema and dependency fingerprints. Content-addressed cache retention must protect artifacts referenced by accepted findings and must not evict the only evidence copy of a published run.

### TS/JS Adapter

1. Discover applicable project configurations and source inclusion; preserve configuration diagnostics.
2. Use Level 1 syntax parsing across eligible files without retaining compiler programs. Load programs/language-service contexts lazily through the shared workspace manager, including JavaScript where appropriate.
3. Persist lightweight function/call/import/registration records first; resolve symbols, aliases, assigned function values, callbacks and returned functions on demand for admitted project contexts.
4. Resolve symbols/signatures to candidate declarations, then map implementations back to the inventory.
5. Preserve boundaries where only types, ambient declarations, generated output, runtime imports, or missing package declarations are available.
6. Build reverse indexes from candidate callee IDs to call sites. Candidate discovery is not proof of runtime dispatch or feasible value flow.
7. Implement a small, bounded local-flow subset: assignments, parameters, returns, destructuring, simple property relationships, and obvious branches. Stop at unsupported aliasing or dynamic writes rather than manufacturing a flow.
8. Support syntax-only fallback with a visible capability downgrade; never silently call it semantic coverage.

The TypeScript compiler does not supply a complete public security dataflow API. Do not depend on undocumented compiler internals or present its type annotations as proof of runtime input trust. Tree-sitter may be a future syntax fallback; it is not necessary for this initial two-language implementation.

### C# Adapter

1. Implement a long-lived .NET sidecar using Roslyn workspaces, semantic models, symbols, `IOperation`, and control-flow graphs.
2. Communicate over a versioned, length-bounded JSON-RPC stdio protocol; diagnostics go to stderr, not the response stream.
3. Discover solution/project membership without eagerly opening the entire solution. Load requested project/target contexts and necessary dependencies in an approved sandbox through the shared workspace manager. Support syntax-only parsing if build metadata cannot be resolved safely.
4. Map methods, constructors, local functions, lambdas, property accessors, expression bodies, and delegate targets to source inventory records.
5. Record candidate virtual/interface implementations, partial methods, generics, extension methods, generated-code origins, and unresolved reflection.
6. Use local data/control-flow information to retrieve relevant definitions and guard branches. Do not claim whole-program alias, concurrency, or taint proofs.
7. Model DI registrations and delegate registrations through explicit framework rules, not by assuming an interface has a single implementation.
8. Bound workspace memory and evict/restart idle sidecars under the shared admission/lease policy. Multi-targeted projects are separate contexts; do not load every target automatically. Failures become task-level partial evidence, not a crashed overall run.

MSBuild project loading, restore, analyzers, generators, and evaluation targets can execute code. Source-generator execution and dependency restoration need a separate approval policy, pinned tools, controlled package sources, and isolation. No user/cloud credentials, host mounts, or container daemon socket are available inside that environment.

## 8. Framework And Azure Evidence Models

Models are small versioned modules with fixtures, not informal claims in prompts. Identify APIs through resolved imports/types/registrations when possible. Name-only matches remain candidates.

| Model Family | Initial Relationships |
| --- | --- |
| Express | Route and middleware registration, mount hierarchy, handler factories, request/response bindings |
| ASP.NET Core | Controllers/minimal endpoints, model binding, middleware sequence, authorization metadata/policies, DI registrations |
| Azure Functions Node.js | Supported programming-model versions, trigger registration, callback payloads, bindings |
| Azure Functions .NET | Trigger/binding attributes, isolated-worker registration and middleware; other models capability-gated |
| Identity | Credential selection, requested audience/resource, principal propagation, role/policy configuration |
| Key Vault | Secret/key retrieval, output propagation and downstream disclosure/storage channels |
| Blob Storage | Account/container/blob selection, object/path semantics, SAS scope and lifetime |
| Data services | SQL/Cosmos query construction versus bound values, tenant/resource selection |
| Messaging | Service Bus/Event Hubs/queue publishing and consuming, payload mapping, retry and duplicate-delivery assumptions |
| API Management | Relevant policy transformations, authentication/authorization configuration and forwarding destinations |
| Infrastructure | Declared resources, identity/role bindings, settings, network restrictions and references across deployment files |

Infrastructure readers must use structured parsers or official tooling where practical. Parse source configuration without executing deployment templates. Expressions and unresolved deployment parameters stay unresolved.

Distinguish three kinds of environment evidence:

- `declared`: source-controlled configuration or infrastructure intent.
- `observed`: explicitly authorized read-only inspection of a deployed resource, with timestamp and resource/version identity.
- `unknown`: deployment settings not established by available evidence.

Live Azure inspection is optional and disabled initially. Add it later behind explicit tenant/subscription/resource scope, least-privilege permissions, data minimization, time limits, and an audit log. Do not reuse unrelated ambient credentials or assume resource-read permissions imply permission to read secrets.

Managed identity proves neither incoming-user authorization nor tenant isolation. Keep the human caller, workload identity, target resource, and delegated permissions as separate graph entities.

### Cross-Language Boundaries

- Represent RPC, queue delivery, subprocess I/O and bindings as boundary edges, not ordinary calls.
- Connect publishers to consumers only with evidence from endpoints/resource configuration, registrations, contracts and serialization.
- Map payload fields through serialization/deserialization; retain unknown fields and version mismatches.
- For messaging, capture ordering, duplicate delivery, acknowledgement and retry assumptions separately from data transfer.
- A matched resource name is a candidate connection; require namespace/account/environment identity before strengthening it.
- Save directed upstream evidence views and bounded paths. Never promise a single full stack across asynchronous services.

## 9. Triage Policy

Use deterministic, versioned rule profiles over the imported classifications. A rule records why a function is selected and which investigation questions it proposes.

| Classification Combination | Initial Investigation Theme |
| --- | --- |
| `operation_outbound_communication` + `influence_target_selection` | Destination control, redirect/address handling and permitted recipients |
| `operation_database_query` + `influence_interpreted_structure` | Query meaning, operators and data-only bindings |
| `operation_credential_handling` + `output_sensitive_*` | Credential use, retention, transfer and intended audience |
| `operation_authorization_decision` + `influence_identity_or_authority` | Principal/resource binding and enforcement |
| `operation_shared_state_check_and_act` | Atomicity and the state-dependent invariant |
| `operation_external_program_execution` + relevant `input_*` | Executable/option/argument control and shell semantics |
| `operation_file_or_object_access` + `influence_target_selection` | File/object boundaries and access policy |
| `operation_content_rendering` + `influence_interpreted_structure` | Consumer-specific interpretation and protection |

Retain label probabilities and uncertainty as evidence about classification, not as a calibrated vulnerability probability. Do not multiply probabilities from correlated questions or rank functions by raw count of `present` labels.

Rules create candidate themes, not findings. A localizer must establish whether the selected dimensions refer to the same operation. A local guard and an unrelated sink in the same function must not become a claim of protection or bypass.

Separate application code, tests, fixtures, examples, vendored code, generated code, and unknown-purpose code in reporting. Use source and package metadata to establish purpose where possible. Do not silently exclude test-oriented components from the underlying inventory or claim that a directory label proves deployment relevance.

Initial pilot selection: 25 operation candidates, reserving approximately 20% for unclear/unflagged control samples with a recorded random seed. Treat the split as configurable evaluation policy, not a correctness threshold.

## 10. Agent Roles And SDK Sessions

Use multiple isolated model contexts, not an unconstrained agent group conversation. The orchestrator assigns bounded tasks; agents do not recursively spawn more agents.

| Role | Input | Allowed Work | Required Output |
| --- | --- | --- | --- |
| Localizer | Sanitized function, classification theme, source map | Locate exact operation and operands | Operation proposal or no-relevant-operation explanation with valid citations |
| Investigator | Operation, current ledger, specific unresolved question | Request bounded evidence and refine a hypothesis | Evidence-linked observations, assumptions, counterevidence, and next questions |
| Challenger | Structured claim and independently assembled evidence | Seek alternative explanations and missing guards | Rebuttal, unresolved prerequisites, or reasons the claim survives |
| Validation planner | Supported candidate and environment constraints | Propose a narrow isolated experiment | Preconditions, expected observations, resources and approval requirements |

Report generation is deterministic over accepted records. An optional narrative model can rephrase summaries later, but cannot add facts or alter dispositions.

### Session Policy

- Create a separate session for each operation/role attempt, or reuse only within that operation and role under an explicit policy.
- Start the runtime in the most minimal supported mode. Disable ambient memories, cross-session stores, repository instructions/hooks, arbitrary MCP discovery and automatic customizations unless explicitly approved.
- Do not place the runtime's working directory inside an untrusted repository when that could auto-load instructions or hooks. Serve source through scoped tools.
- Use explicit per-role tools and default-deny permissions. Never use `approveAll` as the production permission policy.
- Correlate SDK events with run, task, attempt, session and originating message IDs. Streaming text and tool proposals are not terminal results.
- Require result schema validation and citation checks before task completion. A session becoming idle alone is insufficient.
- Persist concise, checkable justifications and observations, not hidden reasoning streams. Do not rely on a model's private chain of thought for reproducibility.
- Build every resumed session from the accepted ledger and exact evidence references. Session compaction is not an authoritative evidence store.
- Verify permissions again on resume; stale permissions must not survive a policy change.

The challenger receives the claim and source-backed evidence, but not the investigator's entire conversational history or a directive to agree. Separation reduces anchoring; it does not create independent proof when the underlying model or evidence is shared.

## 11. Evidence And Investigation Data Contracts

Use versioned schemas and runtime validation at every untrusted boundary.

| Record | Required Fields |
| --- | --- |
| Run | ID, snapshot/index generation, input manifest hashes, config/policy versions, SDK/runtime/model identities, timestamps, resource budgets, coverage |
| Function | Internal/imported IDs, language, project context, original source range/hash, sanitized hash, parent and diagnostics |
| Classification | Function ID, question/rubric hash, selected label, raw probabilities/confidence, original model metadata |
| Operation | ID, owning function, exact expression range/hash, operation family, relevant operands/state, source references |
| Evidence | Content hash, snapshot/file/range identity, evidence kind, producing tool/model version, acquisition time, truncation and sensitivity policy |
| Relationship | From/to evidence nodes, relation type, site, project/path context, evidence basis, alternatives and unresolved reason |
| Query coverage | Query fingerprint, index generation, adapter capability, searched/unsearched scopes, continuation cursor, rows/bytes returned, limits and unresolved reasons |
| Project context | Configuration/target identity, file membership, dependency fingerprints, semantic capability, diagnostics and measured load/resource requirements |
| Claim | Actor, influence, operation, invariant, preconditions, support, counterevidence, assumptions and remaining questions |
| Task/attempt | Dependencies, role, state, attempt/fencing ID, lease/deadline, input hashes, session/message IDs, budget reservation and result reference |
| Validation | Approval binding, sandbox/toolchain hashes, commands, setup, observed outcome, logs/artifacts and limitations |
| Finding | Investigation disposition, impact assessment, evidence strength, reproducibility, coverage caveats and review status |

### Evidence Rules

- Source citations must resolve to actual snapshot spans with matching hashes. A textual quote that appears in several files is not a unique citation.
- Facts, model interpretations, and assumptions occupy separate fields.
- A syntax-backed call candidate is not a verified runtime call. A call path is not automatically a compatible dataflow path.
- Query/source sanitization preserves original coordinates. Retain original source locally; send comment-masked source by default to avoid label leakage. Retrieve documentation separately when intended-use context is needed, with its different evidentiary status made explicit.
- Identify operations by snapshot, exact expression span, semantic context and operation kind. Deduplicate repeated parent/callback discovery without erasing different operands or invariants.
- Cache evidence by source/configuration/tool version. Cache conclusions additionally by question, path context, policy, prompt and model identity.
- Missing dependencies, unknown dispatch, truncated search and failed tools are recorded evidence gaps, not empty successful results.
- Keep supporting and contradicting evidence append-only. Later corrections supersede earlier claims through explicit links rather than silently replacing history.

## 12. Workflow And Bounded Investigation Loop

### Stage A: Verify And Import

Validate dataset files, source identity and schemas; preserve the exact question snapshot and original classifications. No model calls are needed. Produce a baseline coverage manifest and block stale inputs.

### Stage B: Build Navigation Indexes

Stream project/file discovery and Level 1 syntax records into SQLite, checkpointing bounded batches. Map implementations to IDs and store candidate imports/calls/registrations, including unresolved sites. Publish index coverage and generation metadata. Do not open every compiler project; Level 2 semantic resolution is activated by later evidence requests through the shared workspace manager. Optional project warm-up requires explicit admission and remains bounded.

### Stage C: Plan Work

Apply triage profiles, label code-purpose groups, include control samples, reserve budgets, and create candidate tasks. A deterministic seed and rule version make selection reproducible.

### Stage D: Localize

For each candidate, ask the localizer for a precise operation, operands, possible invariant and missing facts. Verify each proposed span against the parser. Merge duplicate operations; reject invented references. Store `no_relevant_operation` outcomes rather than hiding classifier misses.

### Stage E: Investigate

Maintain a worklist of concrete questions rather than repeatedly asking for a broad code review:

```text
FOR each operation admitted by budget:
  initialize ledger from verified operation and source evidence
  enqueue its material unresolved questions

  WHILE unanswered questions remain AND budget/deadline permit:
    choose a question whose answer could change the disposition
    assemble the smallest supported evidence context for that question
    ask investigator for a bounded next action or evidence-linked result
    validate action schema, paths, identifiers, permissions and remaining budget

    IF origin of an operand is missing:
      inspect local definitions and transformations in branch context
      at a parameter, page indexed candidate callers and map actual arguments
      lazily acquire only admitted semantic project contexts for those candidates
      at a call result, inspect bounded candidate return expressions
    ELSE IF a guard or helper contract is missing:
      retrieve the exact implementation, registration, API contract or configuration
    ELSE IF dispatch is unresolved:
      inspect implementations and registrations; use bounded lexical fallback
      preserve competing targets and stop if evidence cannot distinguish them
    ELSE IF a service boundary is encountered:
      map endpoint/resource and payload evidence with explicit delivery assumptions

    retain continuation cursors and unsearched scopes when expansion is deferred
    validate retrieved evidence and relationship citations
    append facts, interpretations, assumptions and counterevidence separately
    enqueue only new questions with a stated decision consequence
    stop revisiting the same evidence/question/path-context combination

  mark unresolved paths, cycles and exhausted budgets explicitly
```

### Stage F: Challenge

Create a fresh challenger session for supported candidates. Check actor control, same-path compatibility, guard ordering, intended policy, deployment assumptions and alternative explanations. Return to investigation only for specific high-value questions within the existing budget.

### Stage G: Validate

When authorized, plan and execute a focused test in an isolated copy. Bind the approval to the exact test/command/environment hashes; any material change requires renewed approval. Compare observed behavior with the claim's preconditions and invariant. A reproduced symptom may still leave impact or attacker reachability unresolved.

### Stage H: Report And Close

Generate reports from accepted records. Every candidate ends with an explicit disposition or pending task, and every report names unexamined areas, unresolved boundaries and available evidence. Do not label the repository safe because no supported candidate remains.

### Dispositions

- `no_relevant_operation`: localization did not establish the proposed review target.
- `needs_context`: a specific missing dependency prevents a supported conclusion.
- `supported_candidate`: current evidence supports review of the hypothesis, without runtime confirmation.
- `refuted_hypothesis`: the particular claim is contradicted by evidence; not a global safety certification.
- `locally_reproduced`: an approved local test observed the claimed behavior under recorded conditions.
- `budget_exhausted`: investigation ended before resolving its material questions.

Task execution states are separate: `queued`, `leased`, `running`, `waiting_for_context`, `waiting_for_approval`, `blocked`, `completed`, `failed`, and `cancelled`. A completed task can produce any appropriate investigation disposition, including an unresolved one.

## 13. Artifact Store And Recovery

### Run Layout

```text
Jeeves/runs/<run-id>/
  manifest.json
  state.sqlite                   # Canonical transactional metadata and queryable navigation indexes
  state.sqlite-wal               # SQLite-managed live files, not standalone backup artifacts
  state.sqlite-shm
  inputs/
    dataset.json
    questions.snapshot.json
    classification-shards/
    source-manifest.json
    configuration.snapshot.json
  snapshot/
    source/
  indexes/
    generation.json
    coverage.json                # Export of accepted index/query coverage
    exports/                     # Optional streamed JSONL exports, not live lookup storage
  tasks/<task-id>/
    task.json                    # Inspectable export; authoritative state is in SQLite
    attempts/<attempt-id>/
      request.json
      result.json
      usage.json
      events.jsonl
  evidence/<hash-prefix>/<content-hash>.json
  investigations/<investigation-id>/
    operation.json
    ledger.jsonl                  # Ordered export of committed ledger events
    current.json                  # Materialized view, regenerable from committed state
    challenge.json
    paths.json
  validations/<validation-id>/
    approval.json
    plan.json
    environment.json
    result.json
    artifacts/
  journal/events.jsonl            # Export of the transactional SQLite event log
  reports/
    investigations.json
    summary.md
    coverage.json
    metrics.json
  checksums.json
```

The orchestrator is the sole logical writer of canonical run state and owns SQLite writes through a bounded database worker, avoiding synchronous heavy queries on the agent event loop. Compiler and agent workers return bounded record batches/results; they never update the database or ledger directly. Read-only access may use bounded prepared queries through the store. Models have no SQL execution tool.

### SQLite Metadata And Navigation Store

Use a pinned, supported SQLite driver with WAL mode on a tested local filesystem, foreign keys enabled, a bounded busy timeout, explicit page-cache limits, and an appropriate durability policy (initially `synchronous=FULL`). Keep transactions short; never hold a write transaction while a model call, compiler load or remote request is in flight. Bound read transactions as well so long readers do not prevent WAL checkpoints indefinitely.

Suggested logical tables and access paths:

| Tables | Indexed Access Patterns |
| --- | --- |
| `snapshots`, `files`, `index_generations`, `index_batches` | Snapshot/path/hash lookup, completed batches and generation publication |
| `projects`, `project_files`, `project_dependencies` | Project/target membership and forward/reverse dependency expansion |
| `functions`, `symbols`, `symbol_definitions` | Function ID, file/range lookup, symbol and defining context |
| `call_sites`, `call_targets`, `registrations`, `boundary_edges` | Candidate callee-to-call-site, caller-to-target, unresolved sites by project/import |
| `classifications`, `classification_answers` | Unique function/question result; selected label or probability filters without loading all transcripts |
| `semantic_results`, `artifact_dependencies`, `query_coverage` | Request fingerprints, input-to-derived invalidation and paginated coverage |
| `tasks`, `attempts`, `leases`, `budget_reservations` | Runnable state/dependencies/priority, active leases and reserved resources |
| `investigations`, `evidence_refs`, `ledger_events`, `events` | Operation/dedup keys, investigation evidence and ordered committed transitions |

Use unique constraints for idempotent imports and result acceptance. Parameterize all SQL values; dynamically selected columns/orderings come from a code-owned allowlist. Validate migrations against both a fresh database and a retained prior schema.

Choose indexes from measured query plans for caller, membership, classification and task lookups. Use keyset pagination and statement time/result budgets rather than large `OFFSET` scans or unrestricted `SELECT *`. Do not attempt to solve all graph traversal with an unbounded recursive SQL query. Stream broad exports and aggregate counts in the database instead of materializing every answer in Node memory.

Record ingestion/index-build completion per generation. Queries may use the last compatible published generation while a new one is built, but must not combine records from different source/configuration generations. An interrupted batch is rolled back or replayed under unique keys.

SQLite is canonical for task/event metadata and committed evidence references. Artifact bytes are canonical in content-addressed files; JSON/JSONL task and journal views are exports, not a competing source of truth. For an archival run bundle, create a consistent SQLite backup using the driver's supported backup/checkpoint procedure. Never hash or copy only a live main database file and omit committed WAL data.

### Persistence Protocol

1. Acquire a per-run coordinator lock with an owner token and lease metadata. PID alone is not a durable ownership identity; apply schema migrations before admitting workers.
2. In one short SQLite transaction, claim a runnable task conditionally on its current state, create an attempt/fencing token, reserve its budget, and append the claim event.
3. Persist immutable request/evidence artifacts, then commit their references before dispatching a model call. Record dispatch intent separately from a provider acknowledgement.
4. Validate the returned result, write a temporary content-addressed artifact, flush as required by the filesystem, and atomically rename on the same filesystem.
5. In one SQLite transaction, verify the attempt fence, commit the accepted result/ledger references and event, reconcile budget accounting, and update task state. Late superseded results cannot complete the task.
6. On restart, trust committed database transitions, verify referenced artifacts, and reconcile orphan files, expired attempts, missing artifacts and partial exports. A file written before a failed database commit is not automatically accepted evidence.
7. Requeue expired leases only after fencing the old attempt. Retain orphan/late-response usage information where possible; never recover missing evidence by silently substituting different bytes.
8. Regenerate JSON/JSONL views from committed state. Do not declare completion until every admitted task has a terminal or explicit waiting/blocked state and required artifacts verify.

Use tested local filesystems. Do not advertise SQLite WAL on NFS/shared drives or multi-writer coordinators as supported. SQLite transactions do not span artifact files, so durable-file-before-reference ordering and reconciliation are mandatory. Disk-full conditions stop new admissions before exhausting reserved recovery space; retain the last committed state and explicit failure reason.

Model calls are at-least-once unless the provider offers usable idempotency guarantees. A timeout may follow a billable server-side completion. Store provider/request IDs and mark such attempts `completion_unknown`; do not claim exactly-once inference or exact cost from incomplete usage events.

SQLite is required for the initial large-repository implementation; an in-memory or file-only metadata store may serve small unit fixtures, not a separate untested production path. Multiple coordinators/machines would require a shared transactional task store, distributed leases and object/artifact storage; they remain a separate optional deployment milestone.

## 14. Budgets, Failure Handling And Observability

Suggested starting limits for a pilot, all configurable and recorded:

- Two concurrent reasoning workers; one request in flight per session.
- A separately configured compiler pool, initially one semantic load at a time until host memory and representative project high-water marks are measured. Never derive semantic concurrency from reasoning-worker count.
- At most 25 operation investigations per pilot, with a reproducible control sample.
- At most 20 model turns and 60 retrieval actions per operation, including challenge follow-up.
- Per-operation wall-clock deadline and evidence/context-byte cap; reserve prompt/response headroom rather than silently truncate a function or schema.
- Bounded graph display paths, for example depth 8 and 20 paths, with explicit truncation markers. Shared evidence edges may be retained beyond displayed paths within the overall exploration budget.
- A run-level model-call and approved cost budget. Count invalid responses, retries and challenge calls against it.

Do not treat these numbers as evaluated defaults until measured. Permit users to resume budget-exhausted investigations with an explicitly increased allowance.

### Resource Admission And Backpressure

Configure a resource envelope before indexing or analysis. Account separately for the coordinator/database worker, syntax workers, semantic process trees, Copilot runtime, validation containers, and an OS/recovery reserve. Monitor actual usage, not just declared reservations.

| Work | Admission And Bound |
| --- | --- |
| Discovery/import | Bounded input chunks and transaction rows/bytes; disk quota and resumable batch checkpoints |
| Syntax parsing | File-size/time cap and limited parser workers; release ASTs after persistence |
| Semantic load | Workspace/process-tree memory reservation, load deadline, loading/resident count limits and sandbox hard limit where supported |
| Navigation query | Query deadline, bounded candidate scopes, output rows/bytes, stable cursor and statement/protocol limits |
| Agent task | Model/token/cost reservations, retrieval allowance, context cap and queue deadline |
| Validation | Separate sandbox CPU/memory/disk/network allowance and bound approval scope |
| Report/export | Streaming records and bounded output buffers; do not load the complete evidence graph to render a summary |

When admission fails, queue within a configured limit, return a retryable backpressure status, or mark the request resource-limited. Do not drop work silently or keep unlimited waiting promises/contexts in memory. Under sustained memory pressure, stop new loads, evict idle workspaces, cancel expired requests, and recycle affected workers before resuming.

Large inputs that exceed a model context window must be explicitly scoped to a cited operation and relevant excerpts or marked unavailable. Never claim a whole-function/full-path conclusion from an undisclosed truncation. Graph display limits are not a claim that undisplayed or unexpanded callers were analyzed.

Failure handling must distinguish:

- Invalid structured result: retain raw response under restricted access, allow bounded repair/retry, then mark failure.
- Authentication, permissions, billing or unavailable model: pause affected tasks; do not hammer the provider or substitute a model silently.
- Rate limit/transient failure: respect provider retry guidance within attempt and run budgets.
- Missing dependency/build context: downgrade capability and record the gap, or block that analysis step.
- Stale source/input: invalidate dependent evidence and require a new snapshot or explicit refresh.
- Worker crash: retain accepted artifacts, fence the attempt, and retry according to policy.
- Resource limit, oversized project or disk pressure: retain coverage and committed work, release reservations, and require a capability downgrade or approved larger budget; do not retry indefinitely.
- Refusal or unsupported request: persist the limitation; never weaken security policy to force an answer.

Record run/task/attempt/session correlation, latency, queue time, tool counts, cache hits, returned token usage, estimated usage where unavailable, and unresolved-edge counts. Measure model execution, indexing, retrieval, validation, paused time and total wall clock separately.

For scale diagnostics, also record peak process-tree RSS, per-project cold-load and warm-query latency, workspace evictions/reloads, coalesced requests, candidate fan-out, pages/scopes examined, SQLite query plans and bounded-query latency, index/WAL/artifact sizes, invalidation fan-out, and resumed versus repeated work. Report p50/p95 latencies and resource-limit rates alongside unresolved-target rates, so a faster run that silently covers less is not mistaken for an improvement.

Telemetry must exclude source, prompts, credentials and raw provider error bodies by default. Secure artifact retention is a separate opt-in policy. If exact usage is unavailable, display unknown/estimated values rather than zero.

## 15. Security Controls

- Treat target code, comments, documentation, build files, model responses and tool output as untrusted data, never higher-priority instructions.
- Mask comments for code investigation by default while retaining exact original spans locally. Sanitization does not remove literals or embedded secrets; apply disclosure policy before sending any context to a model provider.
- Resolve repository paths canonically, enforce snapshot-root containment, reject path traversal and escaping symlinks, and bound file sizes, ranges and result counts.
- Use structured tool arguments. Any necessary external executable is selected from an approved list and invoked with argument arrays, not model-produced shell strings.
- Read tools cannot write source, modify task state, fetch arbitrary network URLs, or reveal credential stores.
- Deny unknown permission kinds and builtin tools by default. Verify effective SDK/runtime tool access rather than assuming a prompt or custom-tool list disables builtins.
- Do not automatically load instructions, hooks, MCP configurations or agent definitions from the target repository.
- Use allowlisted dependency documentation sources and pinned-version contracts where external retrieval is approved. Source comments claiming safety are not API guarantees.
- No host credentials, privileged container access, host Docker socket, production endpoints, or unrestricted network are available to validation workers.
- Use non-root sandboxes, resource limits, read-only input mounts, ephemeral writable directories, and controlled dependency caches. Restore/build/test commands can execute target code and need the same isolation as a test.
- Separate approvals for cloud reads, source disclosure, dependency installation and test execution. Bind each to scope and exact material parameters.
- Keep secrets out of reports. Private evidence artifacts require restrictive permissions and encryption where organizational policy requires it; hashes alone do not anonymize source.
- Never suppress evidence of a restriction by silently falling back to an unrestricted provider/tool.

## 16. Validation And Evaluation Plan

### Deterministic Test Layers

1. Schema/import tests: malformed records, duplicate IDs, missing questions, rounded probabilities, unknown schema versions, large arrays, and stale hashes.
2. Source mapping tests: CRLF, Unicode, expression bodies, nested functions, overloads/accessors, generated origins and offset conversions.
3. Adapter tests: imports/aliases, callbacks, returned handlers, delegates, interfaces, virtual dispatch, multiple project contexts and unresolved calls.
4. Local-flow tests: assignments, branches, transformed values, property aliasing, parameter mapping and deliberately unsupported constructs.
5. Framework tests: route registration versus invocation, middleware order, authorization metadata, DI candidates, trigger bindings and serialization boundaries.
6. Orchestrator tests with fake SDK sessions: concurrency limits, duplicate events, late results, timeouts, budget reservations, cancellations and malformed tool calls.
7. Recovery tests: crash after artifact write/before database commit, committed result before export, stale leases, fencing races, lock contention, WAL recovery, missing artifacts and interrupted model calls.
8. Security tests: prompt injection in source/docs, traversal/symlink escape, secret leakage, unauthorized builtin tools, untrusted build targets and sandbox network escape attempts.
9. Report tests: no fabricated citations, no conversion of `present` into a defect, explicit unresolved coverage and correctly separated impact/evidence/confidence.

### Large-Repository Acceptance Suite

Build a deterministic synthetic corpus generator plus authorized representative snapshots. Vary total files/functions, project count, dependency depth/fan-out, shared-file inclusion, generated sources, TypeScript type complexity, C# target count, file size and caller fan-out independently. Use small/medium/large corpus tiers with at least an order-of-magnitude difference in file and caller counts; repository size alone is not a sufficient stress test.

The benchmark command records hardware, operating system, filesystem, pinned toolchain versions, configured resource envelope, cold/warm cache state and completeness. Set concrete release thresholds in `tests/scale/acceptance-profile.json` before evaluating a release. Latency targets are measured on named hardware, not universal promises; structural bounds are enforced regardless of hardware.

| Scenario | Required Result |
| --- | --- |
| Stream import/index for progressively larger corpora | Peak transient memory stays within the configured buffer/worker envelope; record counts are exact and throughput/disk growth are reported |
| Concurrent requests for the same project | One shared cold load and bounded leases; load count does not grow with the number of requesting agents |
| Many distinct projects under a small memory budget | Queue bounds, fair service and eviction work; resident/loading limits are never exceeded and hard-limit failures are handled where supported |
| A single dependency closure larger than the budget | Explicit `resource_limited`/syntax-only outcome or operator-approved larger worker; no semantic-completeness claim and no infinite restart loop |
| Helper with tens of thousands of candidate callers | Keyset pages are bounded and deterministic, with no duplicates/omissions within the known indexed generation; unresolved dispatch remains visible |
| Cursor reused after a generation change | Reject the stale cursor or deliberately continue against its retained immutable generation; never mix snapshots |
| Local body change and shared signature/configuration change | Correct layers/dependents are invalidated; unrelated reusable artifacts remain intact, and affected findings cannot read stale evidence |
| Missing dependencies and low-budget traversal | Coverage distinguishes unresolved targets, unsearched projects and exhausted budgets from an empty complete-for-scope result |
| Crash/OOM during a load, index batch or result commit | Already committed work survives; replay is idempotent, leases are fenced and requests can resume |
| Disk-full, long reader and WAL growth | Backpressure/checkpoint policy avoids uncontrolled growth; accepted records remain readable and failure is explicit |
| Complete versus deliberately bounded search on a labeled fixture | Bounded runs report the missing scopes and do not invent negative findings for them |
| Large report/export | Streaming produces valid counts and citations within memory/output limits without eagerly materializing the entire graph |

Run lightweight versions of these tests in CI from the storage/indexing stages onward. Keep expensive corpus and multi-target benchmarks as explicit scheduled/release jobs. Separate indexing/navigation scale tests from model-quality/cost tests so model variability cannot hide a deterministic infrastructure regression.

### End-To-End Evaluation

Use a repository-neutral fixture suite and authorized snapshots of realistic applications. Do not pick samples solely because a model already flagged them.

- Include supported and refuted hypotheses, protected sensitive operations, benign serialization, test-only components, opaque helpers, ambiguous dispatch and cross-service boundaries.
- Include historical before/after security changes where ground truth and scope can be independently checked, without exposing expected labels to the investigating agents.
- Hold a subset out from prompt/model tuning. Keep operation localization accuracy separate from vulnerability assessment accuracy.
- Measure reviewed-candidate precision, sensitive-operation recall on a labeled sample, unsupported-edge rate, citation validity, unresolved rate, local reproduction rate, context retrieved and cost per useful investigation.
- Compare against a whole-repository reasoning baseline under equal model, time and token budgets; require evidence of improved review value rather than assuming the architecture is better.
- Run repeated model trials on a fixed sample when measuring stability; cached results are not independent repetitions.
- Human review determines benchmark labels and acceptable thresholds. Agent consensus does not become ground truth.

## 17. Delivery Stages And Acceptance Gates

| Stage | Implementation Work | Exit Criteria |
| --- | --- | --- |
| 0. SDK feasibility | Pin SDK/runtime/toolchain; test auth, isolated sessions, custom tools, default-deny permissions, structured results and cancellation | Offline contract harness plus a tiny authorized live smoke test; no uncontrolled tool access |
| 1. Artifact and metadata foundation | Domain schemas, CLI/config, streaming import, snapshot verification, SQLite tables/migrations/indexes, artifact store, transactional events, locks and recovery | Large imports stay within buffer limits; claims/leases and result references commit atomically; stale data and crash cases pass offline tests |
| 2. Bounded TS/JS navigation | Two-level index, project catalog, compiler pool/workspace manager, request coalescing, admission control, paginated reverse lookup, coverage and dependency invalidation | Synthetic scale tests prove bounded memory/queues, lazy loads, stable pages, explicit unresolved scopes and correct invalidation; no target code executes on host |
| 3. Investigation vertical slice | Triage, localizer, investigator, gateway, ledger, separate model/compiler budgets, structured results and replay tests | Agent concurrency reuses compiler work; high-fan-out retrieval and cancellation stay bounded; prerequisites from Stages 1-2 must pass before live investigation |
| 4. Challenge and reporting | Independent challenge sessions, disposition rules, coverage/metrics, deterministic JSON/Markdown | Every admitted operation has a supported or explicitly unresolved outcome; claims cite valid evidence |
| 5. C# parity | Roslyn sidecar, paginated protocol, lazy project/target contexts, shared admission/eviction, symbols/delegates/interfaces and guarded sandbox loading | Same navigation/coverage and scale contracts pass with multi-target and oversized-project fixtures; no eager whole-solution load |
| 6. Framework/Azure models | ASP.NET/Express/Functions, identity/storage/messaging models, structured IaC readers and cross-language evidence | Supported relationships have versioned fixtures; declared and observed context are never conflated |
| 7. Isolated validation | Approval binding, sandbox executor, environment capture and reproducibility records | Approved tests run without host/source mutation or production access; results reproduce locally |
| 8. Evaluation and hardening | Held-out quality evaluation, control samples, large-corpus benchmarks, artifact retention and cost measurements | Published hardware-specific latency/resource results and coverage metrics meet the acceptance profile; threat-model review complete |
| 9. Optional scale-out | Shared transactional scheduling and artifact/object storage only if a single-host deployment is insufficient | Demonstrated workload need, distributed fencing/recovery tests and preserved evidence/coverage contracts; local SQLite is already implemented, not deferred here |

The first useful milestone is Stages 0-4: a local SQLite-and-artifact-backed, TS/JS-capable investigation loop with bounded memory, explicit coverage and measured cost. Large-repository prerequisites in Stages 1-2 are mandatory before introducing live agent investigations; scale tests start there, not only in final hardening. C# and Azure-specific completeness follow without changing the core task/ledger contracts.

### Definition Of Done For The Initial System

- Existing classification datasets can be imported without rerunning their model evaluations.
- Both supported languages expose the declared navigation capabilities, or explicit per-project limitations.
- No finding depends on an invented source span or an unmarked inferred relationship.
- All task attempts and state transitions are recoverable; interrupted work can resume without discarding accepted evidence.
- Old runs remain interpretable after prompt, rubric, SDK, source or model changes.
- Review priority, potential impact, evidence strength and model uncertainty remain distinct.
- The source repository and production resources remain unchanged by default.
- Live execution and cloud context are explicitly approved and scoped.
- Reports expose unexamined, failed, truncated and unresolved areas as clearly as supported candidates.
- Repository-wide syntax discovery does not eagerly load all semantic contexts, and no compiler workspace is duplicated per reasoning agent.
- Configured process-tree memory, queue, result-page and disk limits are enforced or explicitly identified as soft limits; oversized projects yield recoverable coverage gaps.
- Indexed caller/classification/task lookups paginate, shared loads coalesce, and source/configuration changes invalidate all affected evidence without indiscriminate full-repository recomputation.
- The declared large-corpus acceptance profile passes on recorded hardware, including high-fan-out, multi-project, restart and resource-exhaustion cases.

## 18. Decisions To Confirm During Implementation

- Which GitHub Copilot authentication mode and organization policies are available to the intended operator?
- Which pinned SDK/runtime release passes the permission/cancellation/structured-output gate?
- Which reasoning models are available, and is explicit model-version pinning exposed by the provider? Record limitations if only moving service aliases are available.
- Are C# project restoration and generated-source evaluation allowed in a sandbox, and which package sources may it access?
- Which Azure Functions programming models and deployment formats occur in the initial target set?
- What source-disclosure, artifact retention and encryption policies apply?
- Which validation commands can be preapproved, and which require interactive review?
- What quality/cost thresholds justify moving beyond a small investigation pilot?
- What are the representative project/dependency sizes and host resource envelope, and which OS/container facilities can enforce hard memory limits for both compiler runtimes?
- Which pinned SQLite driver and backup/migration procedures meet portability, durability and query-latency requirements?
- Which measured cold-load, warm-query, unresolved-target and invalidation thresholds define the first large-repository support tier?

These are implementation gates, not reasons to invent unsupported SDK APIs or silently broaden permissions. The local SQLite/artifact architecture, target-neutral contracts and scale harness can be developed and tested offline while access decisions are resolved.

## 19. References

- GitHub Copilot SDK: https://github.com/github/copilot-sdk
- Node.js/TypeScript SDK and documented session/tool APIs: https://github.com/github/copilot-sdk/blob/main/nodejs/README.md
- Original linked library, for distinguishing its purpose: https://github.com/microsoft/Agents-M365Copilot/tree/main/typescript
- TypeSafe Jev API contract: https://docs.typesafe.ai/api
- TypeSafe Choice and confidence semantics: https://docs.typesafe.ai/primitives/choice and https://docs.typesafe.ai/confidence

Recheck published documentation and installed types before implementation. Pin dependencies and record the documentation/model versions used to justify each framework or SDK assumption.