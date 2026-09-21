import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { APIError, TypeSafeClient } from '@typesafe-ai/sdk'

const ts = createRequire(import.meta.url)('typescript')

// Bump this whenever input preparation changes, even if the output happens to
// match for some functions. Old comment-inclusive evaluations must not be reused.
export const sanitizerVersion = 'typescript-comment-mask-v1'

// Inventory source files independently of tsconfig, but avoid dependency trees
// and generated copies that would inflate the review queue with duplicates.
export const excludedDirectories = new Set([
  '.git', 'node_modules', 'build', 'dist', 'coverage', '.angular', '.cache'
])

export function hash (value) {
  return createHash('sha256').update(value).digest('hex')
}

// A signature without a body is not an independently executable implementation.
// This excludes overload signatures, interface methods, and abstract declarations.
function isImplementation (node) {
  return Boolean(node.body) && (
    ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) || ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) || ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  )
}

function functionName (node, sourceFile) {
  if (node.name) return node.name.getText(sourceFile)
  if (ts.isConstructorDeclaration(node)) return 'constructor'
  // Recover useful display names for assigned callbacks without changing source.
  const parent = node.parent
  if (ts.isVariableDeclaration(parent) || ts.isPropertyDeclaration(parent) || ts.isPropertyAssignment(parent)) {
    return parent.name.getText(sourceFile)
  }
  return '<anonymous>'
}

function stripSourceComments (sourceFile) {
  const source = sourceFile.text
  const ranges = []
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, sourceFile.languageVariant)
  let cursor = 0

  // Let the parser identify complete tokens first. Scanning the entire file as
  // plain tokens would misread some regex literals and template interpolations.
  // Only the gaps between parsed tokens are scanned for comment trivia.
  function scanGap (start, end) {
    if (end <= start) return
    scanner.setText(source, start, end - start)
    for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
      if (kind === ts.SyntaxKind.SingleLineCommentTrivia || kind === ts.SyntaxKind.MultiLineCommentTrivia) {
        ranges.push({ start: scanner.getTokenPos(), end: scanner.getTextPos() })
      }
    }
  }

  function visit (node) {
    // JSDoc nodes contain parsed identifiers, but the entire enclosing comment
    // belongs to trivia. Do not protect those identifiers as executable tokens.
    if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) return
    if (node.kind >= ts.SyntaxKind.FirstToken && node.kind <= ts.SyntaxKind.LastToken) {
      // JSX text is literal output, even when it looks like // or /* comments */.
      const start = ts.isJsxText(node) ? node.getFullStart() : node.getStart(sourceFile)
      scanGap(cursor, start)
      cursor = node.getEnd()
      return
    }
    for (const child of node.getChildren(sourceFile)) visit(child)
  }
  visit(sourceFile)
  scanGap(cursor, source.length)

  // Mask rather than delete: offsets, token separation, CRLF, Unicode line
  // terminators, and automatic semicolon insertion must survive unchanged.
  const pieces = []
  cursor = 0
  for (const range of ranges) {
    pieces.push(source.slice(cursor, range.start))
    pieces.push(source.slice(range.start, range.end).replace(/[^\r\n\u2028\u2029]/g, ' '))
    cursor = range.end
  }
  pieces.push(source.slice(cursor))
  return { source: pieces.join(''), ranges }
}

export function extractFunctions (file, source) {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  // Parse in full-file context so class methods, JSX, and nested expressions do
  // not need artificial wrappers that could change their lexical interpretation.
  const sanitized = stripSourceComments(sourceFile)
  const functions = []
  // Preserve parse diagnostics: recovery can still find functions in snippets,
  // but their extraction and sanitization cannot be certified as complete.
  const diagnostics = sourceFile.parseDiagnostics.map(diagnostic => ({
    line: sourceFile.getLineAndCharacterOfPosition(diagnostic.start ?? 0).line + 1,
    message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')
  }))
  const position = offset => {
    const location = sourceFile.getLineAndCharacterOfPosition(offset)
    return { offset, line: location.line + 1, column: location.character + 1 }
  }
  let uncoveredExecutableRegions = 0
  function visit (node, parentId = null) {
    if (isImplementation(node)) {
      const start = node.getStart(sourceFile)
      const end = node.getEnd()
      const id = `${file}:${start}-${end}`
      const declaration = source.slice(start, end)
      const sanitizedFunction = sanitized.source.slice(start, end)
      const body = source.slice(node.body.getStart(sourceFile), node.body.getEnd())
      // Original text remains available for audit. Only sanitizedFunction is
      // submitted to Jev; matching offsets make the two copies easy to compare.
      functions.push({
        id,
        file,
        name: functionName(node, sourceFile),
        kind: ts.SyntaxKind[node.kind],
        parentId,
        start: position(start),
        end: position(end),
        sourceHash: hash(declaration),
        sanitizerVersion,
        sanitizedSourceHash: hash(sanitizedFunction),
        removedCommentCount: sanitized.ranges.filter(range => range.start >= start && range.end <= end).length,
        sanitizedFunction,
        function: declaration,
        body
      })
      // Children retain the enclosing implementation's ID. Their bodies also
      // remain inside the parent's text, so model findings can overlap.
      parentId = id
    } else if (ts.isClassStaticBlockDeclaration(node) || ts.isPropertyDeclaration(node) && node.initializer && !isImplementation(node.initializer)) {
      uncoveredExecutableRegions++
    }
    ts.forEachChild(node, child => visit(child, parentId))
  }
  visit(sourceFile)
  // These counters expose executable regions not evaluated by a function-only
  // workflow; they are coverage warnings, not additional security judgments.
  const topLevelStatements = sourceFile.statements.filter(statement => !(
    ts.isImportDeclaration(statement) || ts.isImportEqualsDeclaration(statement) ||
    ts.isExportDeclaration(statement) || ts.isFunctionDeclaration(statement) ||
    ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) ||
    ts.isClassDeclaration(statement) || ts.isEmptyStatement(statement)
  )).length
  return { functions, diagnostics, uncoveredExecutableRegions, topLevelStatements }
}

export async function inventory (root) {
  const functions = []
  const files = []
  const skipped = []
  async function walk (directory) {
    const entries = await readdir(directory, { withFileTypes: true })
    // Deterministic traversal keeps limited pilot selections reproducible.
    entries.sort((first, second) => first.name.localeCompare(second.name))
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name)
      const relative = path.relative(root, absolute).split(path.sep).join('/')
      if (entry.isSymbolicLink()) {
        // Do not follow links outside the requested root or into traversal loops.
        skipped.push({ file: relative, reason: 'symbolic_link' })
      } else if (entry.isDirectory()) {
        if (excludedDirectories.has(entry.name)) {
          skipped.push({ file: relative, reason: 'dependency_or_generated_directory' })
        } else {
          await walk(absolute)
        }
      } else if (/\.[cm]?[jt]sx?$/i.test(entry.name)) {
        if (/\.d\.[cm]?ts$/i.test(entry.name)) {
          skipped.push({ file: relative, reason: 'declarations_only' })
          continue
        }
        const source = await readFile(absolute, 'utf8')
        const extracted = extractFunctions(relative, source)
        functions.push(...extracted.functions.map(item => ({ ...item, parseDiagnostics: extracted.diagnostics })))
        files.push({
          file: relative,
          sourceHash: hash(source),
          functionCount: extracted.functions.length,
          diagnostics: extracted.diagnostics,
          uncoveredExecutableRegions: extracted.uncoveredExecutableRegions,
          topLevelStatements: extracted.topLevelStatements
        })
      } else {
        skipped.push({ file: relative, reason: 'non_js_ts_file' })
      }
    }
  }
  await walk(root)
  return { functions, files, skipped }
}

export const labels = ['not_applicable', 'locally_protected', 'local_defect', 'context_required']
// This is review routing precedence, not an ordinal vulnerability severity scale.
const priority = ['local_defect', 'context_required', 'locally_protected', 'not_applicable']

function sameKeys (object, keys) {
  return object && typeof object === 'object' && !Array.isArray(object) &&
    Object.keys(object).length === keys.length && keys.every(key => Object.hasOwn(object, key))
}

export function validateQuestions (questions) {
  // Ranking depends on this four-label contract. Reject an incompatible rubric
  // before making any billable API calls instead of silently misinterpreting it.
  if (!questions || typeof questions !== 'object' || Array.isArray(questions) || !Object.keys(questions).length) {
    throw new Error('Questions must be a nonempty object')
  }
  for (const question of Object.values(questions)) {
    if (question?.type !== 'choice' || !question.instructions || !sameKeys(question.criteria, labels)) {
      throw new Error('Every question must be a Choice with the four local-evidence labels')
    }
  }
  return questions
}

export function requestFor (item, questions, model) {
  // Fail closed instead of accidentally sending raw source from an older record.
  // Paths, hashes, original comments, and review labels stay outside model state.
  if (item.sanitizerVersion !== sanitizerVersion || typeof item.sanitizedFunction !== 'string') {
    throw new Error('missing_sanitized_source')
  }
  return { state: { function: item.sanitizedFunction }, model, questions }
}

export function requestKey (item, questions, model) {
  // Include both provenance and exact submitted content. Changing source,
  // preprocessing, location, rubric, or model invalidates the checkpoint.
  return hash(JSON.stringify({ version: 2, sanitizerVersion, sourceHash: hash(item.function), id: item.id, request: requestFor(item, questions, model) }))
}

export function validateResponse (response, questions, model) {
  // SDK types do not establish runtime validity or classification correctness.
  // Check every question, label, distribution, and usage count before caching.
  const isProbability = value => Number.isFinite(value) && value >= 0 && value <= 1
  if (response?.model !== model || !sameKeys(response.answers, Object.keys(questions))) {
    throw new Error('invalid_response')
  }
  for (const answer of Object.values(response.answers)) {
    if (answer?.type !== 'choice' || !labels.includes(answer.choice) ||
        !isProbability(answer.confidence) || !sameKeys(answer.probabilities, labels)) {
      throw new Error('invalid_response')
    }
    const probabilities = Object.values(answer.probabilities)
    // Jev serializes probabilities at two decimal places. Four independently
    // rounded values can deviate from a unit sum by up to 4 * 0.005. Preserve
    // the API values rather than renormalizing and changing the reported evidence.
    const roundingTolerance = labels.length * 0.005 + Number.EPSILON
    if (!probabilities.every(isProbability) ||
      Math.abs(probabilities.reduce((total, value) => total + value, 0) - 1) > roundingTolerance ||
        answer.probabilities[answer.choice] + 0.000001 < Math.max(...probabilities)) {
      throw new Error('invalid_response')
    }
  }
  if (!response.usage || !['input_tokens', 'output_tokens'].every(key => Number.isSafeInteger(response.usage[key]) && response.usage[key] >= 0)) {
    throw new Error('invalid_response')
  }
  return response
}

export function createJevClient (apiKey, { fetchImpl = fetch, retry = {} } = {}) {
  if (!apiKey?.trim()) throw new Error('missing_api_key')
  // Keep source and credentials out of SDK logs. Explicit endpoint selection and
  // redirect rejection prevent environment overrides from redirecting secrets.
  return new TypeSafeClient({
    apiKey,
    baseURL: 'https://api.typesafe.ai',
    logLevel: 'off',
    timeout: 60_000,
    retry: { maxRetries: 3, ...retry },
    fetch: (url, options) => fetchImpl(url, { ...options, redirect: 'error' })
  })
}

export async function evaluate (item, questions, model, client, { signal } = {}) {
  // Per-attempt timeouts alone do not bound retries; also cap the entire call.
  // Construct the request before transport error handling so input errors remain
  // distinguishable from network failures.
  const request = requestFor(item, questions, model)
  const deadline = AbortSignal.timeout(180_000)
  let response
  try {
    response = await client.systemOne(request, {
      signal: signal ? AbortSignal.any([signal, deadline]) : deadline
    })
  } catch (error) {
    // Server error bodies may echo source or credentials. Persist only safe codes.
    if (error instanceof APIError) throw new Error(`http_${error.status}`)
    throw new Error(signal?.aborted ? 'interrupted' : 'network_timeout_or_invalid_response')
  }
  return validateResponse(response, questions, model)
}

export function summarizeAnswers (answers) {
  const values = Object.values(answers)
  // Keep sensitivity, suspected defects, and missing context as separate axes.
  // Maxima avoid summing overlapping categories; they are not exploitability odds.
  return {
    relevance: Math.max(...values.map(answer => 1 - answer.probabilities.not_applicable)),
    defectEvidence: Math.max(...values.map(answer => answer.probabilities.local_defect)),
    contextNeeded: Math.max(...values.map(answer => answer.probabilities.context_required)),
    reviewLabel: priority.find(label => values.some(answer => answer.choice === label)),
    relevantCategories: Object.entries(answers).filter(([, answer]) => answer.choice !== 'not_applicable').map(([category]) => category)
  }
}

export function rankFunctions (items, records) {
  // Failed or pending evaluations must never appear as clean or low-risk results.
  const ranked = items.filter(item => records.get(item.id)?.status === 'evaluated').map(item => {
    const { function: source, body, sanitizedFunction, ...metadata } = item
    const { response } = records.get(item.id)
    return { ...metadata, ...summarizeAnswers(response.answers), model: response.model, answers: response.answers }
  })
  const byId = (first, second) => first.id.localeCompare(second.id)
  // Retain a sensitivity ordering even though the output is sorted as a review
  // queue. All-not-applicable functions and low-confidence answers remain in JSON.
  ranked.sort((first, second) => second.relevance - first.relevance || byId(first, second))
  ranked.forEach((item, index) => { item.relevanceRank = index + 1 })
  ranked.sort((first, second) =>
    priority.indexOf(first.reviewLabel) - priority.indexOf(second.reviewLabel) ||
    second.defectEvidence - first.defectEvidence || second.contextNeeded - first.contextNeeded ||
    second.relevance - first.relevance || byId(first, second)
  )
  ranked.forEach((item, index) => { item.reviewRank = index + 1 })
  return ranked
}