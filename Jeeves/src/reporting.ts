import { mkdir, open, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { atomicJson } from './security.js'
import { Store, getArtifact } from './storage/store.js'
import { withRunLock } from './storage/lock.js'

export async function coverageSummary (store: Store): Promise<Record<string, unknown>> {
  const tasks = await store.query('SELECT state,COUNT(*) AS count FROM tasks GROUP BY state')
  const catalogue = await store.query('SELECT decision,COUNT(*) AS count FROM candidates GROUP BY decision')
  const dispositions = await store.query("SELECT r.disposition,COUNT(*) AS count FROM task_results r JOIN tasks t ON t.id=r.task_id WHERE t.state='completed' GROUP BY r.disposition")
  const followups = await store.query('SELECT state,COUNT(*) AS count FROM followups GROUP BY state')
  const outstanding = tasks.filter(row => row.state !== 'completed').reduce((total, row) => total + Number(row.count), 0)
  const uncertain = dispositions.filter(row => ['needs_context', 'budget_exhausted'].includes(String(row.disposition))).reduce((total, row) => total + Number(row.count), 0)
  return {
    manifest: await store.get('manifest'), plan: await store.get('plan'), index: await store.get('indexStats'),
    execution: { queueDrained: tasks.length > 0 && outstanding === 0, outstandingTasks: outstanding, unresolvedCompletedTasks: uncertain, blockReason: await store.get('blockReason') ?? null },
    tasks, catalogue, dispositions, followups,
    candidatesByTheme: await store.query('SELECT theme,decision,COUNT(*) AS count FROM candidates GROUP BY theme,decision'),
    subjectsByPurpose: await store.query('SELECT purpose,kind,COUNT(*) AS count FROM review_subjects GROUP BY purpose,kind'),
    capabilities: await store.query('SELECT capability,reasons,COUNT(*) AS count FROM coverage GROUP BY capability,reasons'),
    contextCapabilities: await store.query('SELECT capability,reasons,COUNT(*) AS count FROM context_files GROUP BY capability,reasons'),
    filesWithoutSubjects: await store.query('SELECT f.language,COUNT(*) AS count FROM files f WHERE NOT EXISTS(SELECT 1 FROM review_subjects s WHERE s.file=f.path) GROUP BY f.language'),
    omittedFiles: await store.query('SELECT reason,COUNT(*) AS count FROM snapshot_omissions GROUP BY reason'),
    unsupportedSubjects: await store.query("SELECT s.kind,COUNT(*) AS count FROM review_subjects s JOIN context_files c ON c.file=s.file WHERE c.capability='unavailable' GROUP BY s.kind"),
    operationGroups: (await store.query("SELECT COUNT(*) AS distinctOperations,COALESCE(SUM(records),0) AS supportingRecords,COALESCE(SUM(CASE WHEN records>1 THEN 1 ELSE 0 END),0) AS repeatedGroups FROM (SELECT r.operation_key,COUNT(*) AS records FROM task_results r JOIN tasks t ON t.id=r.task_id WHERE t.state='completed' AND r.disposition='supported_candidate' AND r.operation_key IS NOT NULL GROUP BY r.operation_key)"))[0],
    modelCalls: await store.get('modelCalls') ?? 0,
    providerUsage: (await store.query('SELECT COUNT(*) AS observedRequests,SUM(input_tokens) AS reportedInputTokens,SUM(output_tokens) AS reportedOutputTokens,SUM(CASE WHEN input_tokens IS NULL OR output_tokens IS NULL THEN 1 ELSE 0 END) AS incompleteTokenEvents FROM provider_usage'))[0],
    activeElapsedMs: await store.get('runElapsedMs') ?? 0,
    limits: await store.get('limits'), workers: await store.get('workers'), agent: await store.get('agentIdentity'),
    caveats: ['Queue completion is not security certification or proof of exhaustive vulnerability recall.', 'Candidates, operation groups and vulnerability counts are different quantities.', 'Path purpose and declarations do not prove runtime reachability or dataflow.', 'Dependency versions are inventory, not verified advisories.', 'Provider events are observed usage, not a currency total or strict prebilling quota.', 'An unclean shutdown conservatively charges elapsed time until recovery against the time budget.', 'Follow-up proposals require operator approval.']
  }
}

function escape (value: unknown): string { return String(value).replace(/[&<>|\[\]`\\]/g, char => `&#${char.charCodeAt(0)};`).replace(/[\r\n]/g, ' ') }

export async function report (run: string): Promise<Record<string, unknown>> {
  return await withRunLock(run, async () => await writeReport(run))
}

async function writeReport (run: string): Promise<Record<string, unknown>> {
  const store = await Store.open(run)
  const directory = path.join(run, 'reports'); await mkdir(directory, { recursive: true, mode: 0o700 })
  const jsonFile = path.join(directory, 'investigations.json')
  const markdownFile = path.join(directory, 'summary.md')
  const json = await open(jsonFile + '.tmp', 'w', 0o600); const markdown = await open(markdownFile + '.tmp', 'w', 0o600)
  const candidates = await open(path.join(directory, 'candidates.jsonl.tmp'), 'w', 0o600)
  const followups = await open(path.join(directory, 'followups.jsonl.tmp'), 'w', 0o600)
  let complete = false
  try {
    await json.write('[\n')
    const coverage = await coverageSummary(store)
    await markdown.write(`# Jeeves Source Review\n\nModel hypotheses, not verified vulnerabilities. No target code was executed. Queue completion and security coverage are reported separately.\n\nExecution: ${escape(JSON.stringify(coverage.execution))}\n\n| Subject | Theme | Purpose | State | Disposition | Summary |\n| --- | --- | --- | --- | --- | --- |\n`)
    let count = 0
    for await (const task of store.scan('tasks')) {
      const result = task.result ? await getArtifact<Record<string, unknown>>(run, String(task.result)) : null
      const subject = (await store.query('SELECT s.id,s.file,s.start,s.end,s.kind,s.purpose FROM review_subjects s JOIN candidates c ON c.subject_id=s.id WHERE c.id=?', [String(task.id)]))[0] ?? null
      const record = { ...task, subject, result, resultIsFinal: task.state === 'completed' }
      await json.write((count ? ',\n' : '') + JSON.stringify(record))
      await markdown.write(`| ${escape(subject ? `${subject.file}:${subject.start}-${subject.end}` : String(task.id).slice(0, 12))} | ${escape(task.theme)} | ${escape(task.purpose)} | ${escape(task.state)} | ${escape(task.state === 'completed' ? result?.disposition ?? 'unexamined' : 'intermediate_or_unexamined')} | ${escape(result?.summary ?? task.error ?? 'No accepted result')} |\n`)
      count++
    }
    await json.write('\n]\n'); await json.sync(); await markdown.sync()
    for await (const row of store.scan('candidates')) await candidates.write(JSON.stringify({ ...row, reason: JSON.parse(String(row.reason)) }) + '\n')
    for await (const row of store.scan('followups')) await followups.write(JSON.stringify({ ...row, operation: JSON.parse(String(row.operation)) }) + '\n')
    await candidates.sync(); await followups.sync()
    await atomicJson(path.join(directory, 'coverage.json'), coverage)
    complete = true
    return { investigations: count, ...coverage }
  } finally {
    await json.close(); await markdown.close(); await candidates.close(); await followups.close(); await store.close()
    for (const file of [jsonFile, markdownFile, path.join(directory, 'candidates.jsonl'), path.join(directory, 'followups.jsonl')]) {
      if (complete) await rename(file + '.tmp', file)
      else await rm(file + '.tmp', { force: true })
    }
  }
}