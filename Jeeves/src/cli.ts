#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { importDataset } from './datasets/import.js'
import { Store } from './storage/store.js'
import { recoverLock } from './storage/lock.js'
import { errorCode } from './security.js'
import { buildIndex } from './analysis/index.js'
import { Navigation } from './analysis/navigation.js'
import { approveFollowups, continueInconclusive, planTasks } from './orchestration/tasks.js'
import { withRunLock } from './storage/lock.js'
import { createClient, stopClient } from './copilot/client.js'
import { CopilotBackend } from './agents/runner.js'
import { runInvestigations } from './orchestration/run.js'
import { coverageSummary, report } from './reporting.js'
import { retryFailedTasks } from './orchestration/tasks.js'
import { defaultLimits, limitsSchema } from './domain.js'
import { readBounded } from './security.js'
import { approveValidation, executeValidation } from './validation.js'
import { evaluateReviewBenchmark } from './review-benchmark.js'

export async function main (args = process.argv.slice(2)): Promise<void> {
  const command = args[0]
  if (!command || command === '--help' || command === 'help') {
    console.log(`Jeeves: classification-guided security investigation

doctor
import --dataset <directory> --repo <root> --run <directory>
index --run <directory> [--reuse-run <previous-run>] [--semantic-project <tsconfig-or-csproj>]
plan --run <directory> [--mode full|sample] [--max-operations <sample-count>] [--include-non-application]
run --run <directory> --model <model> --allow-live [--workers 2] [--config <limits.json>] --max-run-hours <hours>
resume --run <directory> --model <model> --allow-live [--retry-failed] [--continue-inconclusive]
approve-followups --run <directory> --followups <comma-separated-ids> --approve-followups
resume --run <directory> --recover-lock
status --run <directory>
report --run <directory>
review-benchmark --run <directory> --benchmark <version-pinned-json>
validate --run <directory> --validation-plan <file> --approve-execution
validate --run <directory> --approval <id>

Source is transmitted only by an explicitly approved live run. No command pushes code.`)
    return
  }
  const { values } = parseArgs({ args: args.slice(1), options: {
    dataset: { type: 'string' }, repo: { type: 'string' }, run: { type: 'string' },
    config: { type: 'string' }, model: { type: 'string' }, workers: { type: 'string' }, mode: { type: 'string' },
    'max-operations': { type: 'string' }, 'semantic-project': { type: 'string' },
    'reuse-run': { type: 'string' },
    'include-non-application': { type: 'boolean' }, 'max-run-hours': { type: 'string' }, 'max-role-calls': { type: 'string' }, 'max-run-requests': { type: 'string' }, 'attempt-seconds': { type: 'string' },
    'continue-inconclusive': { type: 'boolean' }, followups: { type: 'string' }, 'approve-followups': { type: 'boolean' },
    benchmark: { type: 'string' },
    'recover-lock': { type: 'boolean' }, 'allow-live': { type: 'boolean' }, 'retry-failed': { type: 'boolean' },
    approval: { type: 'string' }, 'validation-plan': { type: 'string' }, 'approve-execution': { type: 'boolean' }
  } })
  if (command === 'doctor') {
    const dotnet = spawnSync('dotnet', ['--list-sdks'], { encoding: 'utf8', timeout: 5000 })
    const docker = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], { encoding: 'utf8', timeout: 5000 })
    console.log(JSON.stringify({ node: process.version, copilotSdk: '1.0.14', sqlite: 'node:sqlite', dotnetAvailable: dotnet.status === 0, sandboxAvailable: docker.status === 0, liveSourceAnalysisRequiresApproval: true }, null, 2))
    return
  }
  if (!values.run) throw new Error('run_path_required')
  const run = path.resolve(values.run)
  let limits = values.config ? limitsSchema.parse(JSON.parse((await readBounded(path.dirname(path.resolve(values.config)), path.basename(values.config), 65536)).toString())) : defaultLimits
  if (command === 'import') {
    if (!values.repo || !values.dataset) throw new Error('import_paths_required')
    console.log(JSON.stringify(await importDataset(values.dataset, values.repo, run), null, 2)); return
  }
  if (command === 'resume' && values['recover-lock']) { await recoverLock(run); console.log('lock_recovered'); return }
  if (command === 'index') {
    console.log(JSON.stringify(await buildIndex(run, values['reuse-run']), null, 2))
    if (values['semantic-project']) {
      const store = await Store.open(run); const navigation = new Navigation(store, limits)
      try {
        const call = (await store.query('SELECT file,start FROM calls ORDER BY id LIMIT 1'))[0]
        if (call) console.log(JSON.stringify(await navigation.resolve(String(call.file), Number(call.start), values['semantic-project']), null, 2))
      } finally { navigation.close(); await store.close() }
    }
    return
  }
  if (command === 'plan') {
    const mode = values.mode ?? (values['max-operations'] ? 'sample' : 'full')
    if (mode !== 'full' && mode !== 'sample') throw new Error('invalid_plan_mode')
    await withRunLock(run, async () => {
      const store = await Store.open(run)
      try { console.log(JSON.stringify(await planTasks(store, { mode, maximum: values['max-operations'] ? Number(values['max-operations']) : undefined, includeNonApplication: values['include-non-application'] }), null, 2)) } finally { await store.close() }
    })
    return
  }
  if (command === 'approve-followups') {
    if (!values['approve-followups'] || !values.followups) throw new Error('explicit_followup_approval_required')
    await withRunLock(run, async () => {
      const store = await Store.open(run)
      try { console.log(JSON.stringify(await approveFollowups(store, values.followups!.split(',')), null, 2)) } finally { await store.close() }
    })
    return
  }
  if (command === 'status') {
    const store = await Store.open(run, true)
    try {
      const version = Number((await store.query('PRAGMA user_version'))[0]?.user_version)
      console.log(JSON.stringify(version < 2 ? { legacyRun: true, manifest: await store.get('manifest'), tasks: await store.query('SELECT state,COUNT(*) AS count FROM tasks GROUP BY state') } : await coverageSummary(store), null, 2))
    } finally { await store.close() }
    return
  }
  if (command === 'report') { console.log(JSON.stringify(await report(run), null, 2)); return }
  if (command === 'review-benchmark') {
    if (!values.benchmark) throw new Error('benchmark_path_required')
    console.log(JSON.stringify(await evaluateReviewBenchmark(run, values.benchmark), null, 2)); return
  }
  if (command === 'validate') {
    if (values['validation-plan'] && values['approve-execution']) { console.log(JSON.stringify(await approveValidation(run, values['validation-plan']), null, 2)); return }
    if (!values.approval) throw new Error('explicit_validation_approval_required')
    console.log(JSON.stringify(await executeValidation(run, values.approval), null, 2)); return
  }
  if (command === 'run' || command === 'resume') {
    if (!values['allow-live']) throw new Error('live_source_disclosure_requires_allow_live')
    if (!values.model) throw new Error('explicit_model_required')
    let workers = values.workers ? Number(values.workers) : 2
    if (command === 'resume') {
      const store = await Store.open(run, true)
      try {
        if (!values.config) limits = limitsSchema.parse(await store.get('limits') ?? {})
        if (!values.workers) workers = await store.get<number>('workers') ?? 2
      } finally { await store.close() }
    }
    limits = limitsSchema.parse({ ...limits,
      ...(values['max-run-hours'] ? { maxRunDurationMs: Math.round(Number(values['max-run-hours']) * 3600000) } : {}),
      ...(values['max-role-calls'] ? { maxModelCalls: Number(values['max-role-calls']) } : {}),
      ...(values['max-run-requests'] ? { maxRunProviderRequests: Number(values['max-run-requests']) } : {}),
      ...(values['attempt-seconds'] ? { modelTimeoutMs: Number(values['attempt-seconds']) * 1000 } : {})
    })
    if (limits.maxRunDurationMs === null && limits.maxModelCalls === null && limits.maxRunProviderRequests === null) throw new Error('explicit_overall_budget_required')
    if (values['retry-failed'] || values['continue-inconclusive']) await withRunLock(run, async () => {
      const store = await Store.open(run)
      try { if (values['retry-failed']) await retryFailedTasks(store); if (values['continue-inconclusive']) await continueInconclusive(store) } finally { await store.close() }
    })
    const client = await createClient(run)
    const controller = new AbortController()
    const cancel = () => controller.abort()
    process.once('SIGINT', cancel); process.once('SIGTERM', cancel)
    try {
      const models = await client.listModels()
      if (!models.some(model => model.id === values.model)) throw new Error('model_unavailable')
      const outcome = await runInvestigations(run, new CopilotBackend(client, values.model, run, limits), workers, limits, controller.signal)
      console.log(JSON.stringify(outcome, null, 2))
      if ((outcome.tasks as Array<{ state: string }>).some(task => task.state !== 'completed')) process.exitCode = 1
      await report(run)
    } finally { process.off('SIGINT', cancel); process.off('SIGTERM', cancel); await stopClient(client) }
    return
  }
  throw new Error('unknown_command')
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(errorCode(error)); process.exitCode = 1 })
}