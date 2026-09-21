import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { createJevClient, evaluate, hash, inventory, rankFunctions, requestKey, sanitizerVersion, validateQuestions, validateResponse } from './analysis.mjs'

const directory = path.dirname(fileURLToPath(import.meta.url))
const defaultModel = 'jev-1.13.0'

async function writeJson (file, value) {
  const temporary = `${file}.tmp`
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
  await rename(temporary, file)
}

function markdownText (value) {
  return String(value).replace(/[&<>|\[\]`\\]/g, character => `&#${character.charCodeAt(0)};`).replace(/[\r\n]/g, ' ')
}

function reportMarkdown (summary, ranked, root, output) {
  const lines = [
    '# Function Security Review Queue',
    '',
    `Status: **${summary.status}**. Evaluated ${summary.evaluated}/${summary.selected} selected functions; ${summary.failed} failed; ${summary.pending} pending.`,
    '',
    `Inventory: ${summary.functions} functions in ${summary.files} TS/JS files. ${summary.filesWithParseErrors} files have parse errors; extraction in those files is best effort.`,
    '',
    `Input preparation: ${summary.sanitizerVersion}. Comments are masked with spaces, preserving line breaks, offsets, and literal contents. Original and submitted text are retained in functions.jsonl.`,
    '',
    'Local evidence only, not confirmed vulnerabilities. Nested function bodies overlap with their parents. Top-level execution, templates, configuration, excluded directories, and non-TS/JS files are not evaluated.',
    '',
    'Relevance = max(1 - P(not_applicable)); defect = max(P(local_defect)); context = max(P(context_required)). Maxima are ranking heuristics, not exploitability probabilities.',
    '',
    'Ordered by local_defect, context_required, locally_protected, then descending defect, context, and relevance scores. Functions whose selected answers are all not_applicable remain in ranked.json, with independent relevanceRank and reviewRank fields.',
    '',
    '| Review Rank | Function | Source | Evidence | Relevance | Defect | Context | Categories |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |'
  ]
  for (const item of ranked.filter(item => item.relevantCategories.length)) {
    const relative = path.relative(output, path.join(root, item.file)).split(path.sep).map(encodeURIComponent).join('/')
    const location = `${markdownText(item.file)}:${item.start.line}${item.parseDiagnostics.length ? ' (parse warnings)' : ''}`
    lines.push(`| ${item.reviewRank} | ${markdownText(item.name)} | [${location}](${relative}#L${item.start.line}) | ${item.reviewLabel} | ${item.relevance.toFixed(3)} | ${item.defectEvidence.toFixed(3)} | ${item.contextNeeded.toFixed(3)} | ${item.relevantCategories.join(', ')} |`)
  }
  return lines.join('\n') + '\n'
}

export async function runAnalysis ({
  root = path.join(directory, 'juice-shop'),
  questionsPath = path.join(directory, 'questions.json'),
  output = path.join(directory, 'analysis-output'),
  model = defaultModel,
  inventoryOnly = false,
  concurrency = 6,
  limit = Infinity,
  file = '',
  apiKey = process.env.TYPESAFE_API_KEY,
  signal
} = {}, { client, onProgress = () => {} } = {}) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) throw new Error('Concurrency must be between 1 and 16')
  if (limit !== Infinity && (!Number.isInteger(limit) || limit < 1)) throw new Error('Limit must be a positive integer')
  if (!/^jev-\d+\.\d+\.\d+$/.test(model)) throw new Error('Use a pinned Jev version, not a moving alias')
  root = path.resolve(root)
  output = path.resolve(output)
  if (output === root || output.startsWith(root + path.sep)) throw new Error('Keep analysis output outside the scanned repository')
  const questions = validateQuestions(JSON.parse(await readFile(questionsPath, 'utf8')))
  await mkdir(output, { recursive: true, mode: 0o700 })
  const lockPath = path.join(output, '.lock')
  const lock = await open(lockPath, 'wx', 0o600).catch(() => { throw new Error('Output is locked; check for an active scan before removing analysis-output/.lock') })
  try {
    await lock.writeFile(String(process.pid))
    const startedAt = new Date().toISOString()
    const scanned = await inventory(root)
    const selected = scanned.functions.filter(item => item.file.includes(file)).slice(0, limit)
    await writeJson(path.join(output, 'inventory.json'), {
      root, startedAt, sanitizerVersion, files: scanned.files, skipped: scanned.skipped,
      functions: scanned.functions.length,
      scope: 'TS/JS implementation bodies, including nested functions; declarations, dependencies, generated directories, symlinks, and other file types excluded'
    })
    await writeFile(path.join(output, 'functions.jsonl'), scanned.functions.map(item => JSON.stringify(item)).join('\n') + '\n', { mode: 0o600 })
    const cache = path.join(output, 'cache')
    await mkdir(cache, { recursive: true, mode: 0o700 })
    const records = new Map()
    const queue = []
    let reused = 0
    let newInputTokens = 0
    for (const item of selected) {
      const key = requestKey(item, questions, model)
      let previous
      try {
        previous = JSON.parse(await readFile(path.join(cache, `${key}.json`), 'utf8'))
        if (previous.status !== 'evaluated' || previous.key !== key) previous = undefined
        if (previous) validateResponse(previous.response, questions, model)
      } catch {
        previous = undefined
      }
      if (previous) {
        records.set(item.id, previous)
        reused++
      } else {
        queue.push({ item, key })
      }
    }
    let blocked = !inventoryOnly && !client && !apiKey?.trim() ? 'missing_api_key' : null
    let completed = reused
    onProgress({ completed, selected: selected.length, queued: queue.length, reused })
    if (!inventoryOnly && !blocked && queue.length) {
      client ??= createJevClient(apiKey)
      let cursor = 0
      let consecutiveFailures = 0
      async function worker () {
        while (cursor < queue.length && !blocked && !signal?.aborted) {
          const { item, key } = queue[cursor++]
          let record
          try {
            const response = await evaluate(item, questions, model, client, { signal })
            record = { key, status: 'evaluated', evaluatedAt: new Date().toISOString(), response }
            newInputTokens += response.usage.input_tokens
            consecutiveFailures = 0
          } catch (error) {
            record = { key, status: 'failed', error: error.message }
            consecutiveFailures++
            if (['http_401', 'http_402', 'http_403', 'http_404'].includes(error.message) || consecutiveFailures >= 12) {
              blocked = error.message
            }
          }
          records.set(item.id, record)
          await writeJson(path.join(cache, `${key}.json`), record)
          completed++
          onProgress({ completed, selected: selected.length, file: item.file, status: record.status, error: record.error, newInputTokens })
        }
      }
      await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, () => worker()))
    }
    const ranked = rankFunctions(selected, records)
    const failures = selected.filter(item => records.get(item.id)?.status === 'failed').map(item => ({ id: item.id, error: records.get(item.id).error }))
    const pending = selected.filter(item => !records.has(item.id)).map(item => item.id)
    const summary = {
      status: inventoryOnly ? 'inventory_only' : blocked ? 'blocked' : signal?.aborted ? 'interrupted' : failures.length || pending.length ? 'partial' : 'complete',
      blockReason: blocked,
      root, model, sanitizerVersion, questionsHash: hash(JSON.stringify(questions)), questionCount: Object.keys(questions).length,
      startedAt, finishedAt: new Date().toISOString(),
      files: scanned.files.length, functions: scanned.functions.length, selected: selected.length,
      filesWithParseErrors: scanned.files.filter(item => item.diagnostics.length).length,
      evaluated: ranked.length, reused, failed: failures.length, pending: pending.length,
      newInputTokens,
      evaluationCompleteForSelection: !inventoryOnly && ranked.length === selected.length,
      selectionCoversInventory: selected.length === scanned.functions.length,
      coverageCaveat: 'Parse errors and excluded/non-function code prevent a claim of whole-repository security coverage.',
      failures, pendingIds: pending
    }
    await writeJson(path.join(output, 'ranked.json'), ranked)
    await writeJson(path.join(output, 'summary.json'), summary)
    await writeFile(path.join(output, 'report.md'), reportMarkdown(summary, ranked, root, output), { mode: 0o600 })
    return summary
  } finally {
    await lock.close()
    await rm(lockPath, { force: true })
  }
}

async function main () {
  const { values } = parseArgs({ options: {
    'inventory-only': { type: 'boolean', default: false },
    root: { type: 'string' }, questions: { type: 'string' }, output: { type: 'string' },
    model: { type: 'string' }, concurrency: { type: 'string' }, limit: { type: 'string' }, file: { type: 'string' }
  } })
  const controller = new AbortController()
  process.once('SIGINT', () => controller.abort())
  process.once('SIGTERM', () => controller.abort())
  const summary = await runAnalysis({
    root: values.root, questionsPath: values.questions, output: values.output, model: values.model,
    inventoryOnly: values['inventory-only'],
    concurrency: values.concurrency === undefined ? undefined : Number(values.concurrency),
    limit: values.limit === undefined ? undefined : Number(values.limit),
    file: values.file, signal: controller.signal
  }, { onProgress: progress => {
    if (progress.completed % 100 === 0 || progress.status === 'failed' || progress.completed === progress.selected || progress.queued !== undefined) {
      console.log(JSON.stringify(progress))
    }
  } })
  const { pendingIds, failures, ...overview } = summary
  console.log(JSON.stringify(overview, null, 2))
  if (!['complete', 'inventory_only'].includes(summary.status)) process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(error.code ? `Analysis failed: ${error.code}` : error.message)
    process.exitCode = 1
  })
}