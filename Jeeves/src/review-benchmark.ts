import path from 'node:path'
import { z } from 'zod'
import { digestSchema } from './domain.js'
import { atomicJson, hash, readBounded, relativePath } from './security.js'
import { Store, getArtifact } from './storage/store.js'
import { withRunLock } from './storage/lock.js'

const benchmarkSchema = z.object({
  schemaVersion: z.literal(1), repository: z.string().min(1), revision: z.string().min(1),
  description: z.string().min(1),
  cases: z.array(z.object({
    id: z.string().min(1).max(200), rootCause: z.string().min(1).max(2000),
    expected: z.enum(['positive', 'negative', 'historical', 'unverified']),
    file: z.string().min(1).max(1024), fileHash: digestSchema.optional(),
    line: z.number().int().positive(), themes: z.array(z.string().min(1)).min(1).max(20),
    caveat: z.string().max(4000)
  }).strict()).min(1).max(500)
}).strict()

export async function evaluateReviewBenchmark (run: string, filename: string): Promise<Record<string, unknown>> {
  return await withRunLock(run, async () => {
    const resolved = path.resolve(filename)
    const specification = benchmarkSchema.parse(JSON.parse((await readBounded(path.dirname(resolved), path.basename(resolved), 2 * 1024 * 1024)).toString()))
    if (new Set(specification.cases.map(entry => entry.id)).size !== specification.cases.length) throw new Error('duplicate_benchmark_case')
    const store = await Store.open(run, true)
    try {
      const manifest = await store.get<{ repository: string, revision: string }>('manifest')
      if (manifest?.repository !== specification.repository || manifest.revision !== specification.revision) throw new Error('benchmark_revision_mismatch')
      const cases: Array<Record<string, unknown>> = []
      let applicablePositive = 0; let selectedPositive = 0; let investigatedPositive = 0; let supportedPositive = 0; let falsePositiveFlags = 0
      for (const entry of specification.cases) {
        relativePath(entry.file)
        if (['historical', 'unverified'].includes(entry.expected)) { cases.push({ ...entry, status: entry.expected === 'historical' ? 'not_applicable' : 'applicability_unverified' }); continue }
        if (entry.expected === 'positive') applicablePositive++
        const file = (await store.query('SELECT hash FROM files WHERE path=?', [entry.file]))[0]
        if (!file) { cases.push({ ...entry, status: 'unsupported_evidence', reason: 'file_not_in_snapshot' }); continue }
        const source = (await readBounded(path.join(run, 'snapshot/source'), entry.file, 16 * 1024 * 1024)).toString()
        if (hash(source) !== file.hash || entry.fileHash && entry.fileHash !== file.hash) throw new Error('benchmark_source_mismatch')
        const lines = source.split('\n')
        if (entry.line > lines.length) throw new Error('benchmark_line_outside_source')
        const offset = lines.slice(0, entry.line - 1).reduce((total, line) => total + line.length + 1, 0)
        const end = offset + lines[entry.line - 1]!.length
        const rows = await store.query(`SELECT c.id,c.theme,c.decision,t.state,t.result FROM candidates c
          JOIN review_subjects s ON s.id=c.subject_id LEFT JOIN tasks t ON t.id=c.id
          WHERE s.file=? AND s.start<=? AND s.end>? AND c.theme IN (${entry.themes.map(() => '?').join(',')})`, [entry.file, end, offset, ...entry.themes])
        const selected = rows.some(row => row.state !== null)
        const completed = rows.filter(row => row.state === 'completed' && row.result)
        const outcomes: string[] = []
        for (const row of completed) {
          const result = await getArtifact<{ disposition: string, operation?: { file: string, start: number, end: number } | null }>(run, String(row.result))
          if (result.operation && (result.operation.file !== entry.file || result.operation.start > end || result.operation.end <= offset)) continue
          outcomes.push(result.disposition)
        }
        const supported = outcomes.includes('supported_candidate')
        const refuted = outcomes.includes('refuted_hypothesis') || outcomes.includes('no_relevant_operation')
        let status = !rows.length ? 'no_candidate' : !selected ? rows.some(row => row.decision === 'unsupported') ? 'unsupported_evidence' : rows.every(row => row.decision === 'excluded') ? 'excluded_by_scope' : 'unselected' : !completed.length ? rows.some(row => row.state === 'failed') ? 'failed' : 'pending' : supported ? entry.expected === 'negative' ? 'potential_false_positive' : 'supported' : refuted ? 'refuted' : 'unresolved'
        if (!outcomes.length && completed.length) status = 'different_operation_reviewed'
        if (entry.expected === 'positive') { if (selected) selectedPositive++; if (outcomes.length) investigatedPositive++; if (supported) supportedPositive++ }
        if (entry.expected === 'negative' && supported) falsePositiveFlags++
        cases.push({ ...entry, status, candidateIds: rows.map(row => row.id), matchingConclusions: outcomes })
      }
      const result = {
        schemaVersion: 1, specificationHash: hash(JSON.stringify(specification)), repository: specification.repository, revision: specification.revision,
        applicablePositive, selectedPositive, investigatedPositive, supportedPositive, falsePositiveFlags,
        selectionRecall: applicablePositive ? selectedPositive / applicablePositive : null,
        detectionRecall: investigatedPositive ? supportedPositive / applicablePositive : null,
        conditionalDetectionRecall: investigatedPositive ? supportedPositive / investigatedPositive : null,
        precision: null, precisionReason: 'Requires independent adjudication of every reported distinct finding, not just benchmark cases.',
        cases, caveats: ['This is a version-pinned review-obligation benchmark, not exploit reproduction or exhaustive ground truth.', 'Overlapping functions and themes count once per benchmark case.', 'Expected labels are read only by this evaluator, never inserted into agent context.', 'No model calls or target execution occur.']
      }
      await atomicJson(path.join(run, 'reports/benchmark.json'), result)
      return result
    } finally { await store.close() }
  })
}