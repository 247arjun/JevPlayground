import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { classifyFunctions, createJevClient, evaluate, extractFunctions, hash, inventory, labels, questionMode, rankFunctions, requestFor, requestKey, sanitizerVersion, validateQuestions, validateResponse } from './analysis.mjs'
import { runAnalysis } from './analyze.mjs'

test('extracts all executable function forms with exact source and nesting', () => {
  const source = `
export function factory(input: string) {
  function helper() { return input }
  return async () => helper()
}
const expression = function named() { return 1 }
const arrow = value => value + 1
const object = { method() {}, property: () => 1, get value() { return 1 }, set value(next) {} }
class Example {
  constructor() {}
  async method() {}
  field = () => 1
  get value() { return 1 }
  set value(next) {}
}
declare function declaration(): void
abstract class Abstract { abstract absent(): void }
function overload(input: string): string
function overload(input: string) { return input }
[1].map(value => value)
function* generator() { yield 1 }
`
  const result = extractFunctions('fixture.ts', source)
  assert.deepEqual(result.diagnostics, [])
  assert.equal(result.functions.length, 17)
  const factory = result.functions.find(item => item.name === 'factory')
  assert.equal(result.functions.filter(item => item.parentId === factory.id).length, 2)
  assert.equal(result.functions.filter(item => item.name === 'overload').length, 1)
  assert.ok(!result.functions.some(item => ['declaration', 'absent'].includes(item.name)))
  for (const item of result.functions) {
    assert.equal(item.function, source.slice(item.start.offset, item.end.offset))
    assert.ok(item.function.includes(item.body))
  }
  assert.equal(result.functions.find(item => item.name === 'arrow').body, 'value + 1')
})

test('parses TSX and reports syntax errors without claiming clean coverage', () => {
  const result = extractFunctions('component.tsx', 'const View = () => <div onClick={() => run()} />')
  assert.equal(result.functions.length, 2)
  assert.deepEqual(result.diagnostics, [])
  assert.ok(extractFunctions('broken.ts', 'function broken( {').diagnostics.length > 0)
})

test('records initialization outside function bodies', () => {
  const result = extractFunctions('init.ts', 'run(); class Example { field = work(); static { work() } }')
  assert.equal(result.topLevelStatements, 1)
  assert.equal(result.uncoveredExecutableRegions, 2)
})

test('scans frontend, tests, and static source independent of tsconfig', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jev-inventory-'))
  try {
    for (const directory of ['frontend', 'test', 'data/static/codefixes', 'node_modules']) {
      await mkdir(path.join(root, directory), { recursive: true })
      await writeFile(path.join(root, directory, 'example.ts'), 'const example = () => 1')
    }
    await writeFile(path.join(root, 'script.mjs'), 'export function script() {}')
    await writeFile(path.join(root, 'types.d.ts'), 'declare function absent(): void')
    await writeFile(path.join(root, 'template.hbs'), '{{value}}')
    await symlink(path.join(root, 'frontend'), path.join(root, 'linked'))
    const result = await inventory(root)
    assert.equal(result.functions.length, 4)
    assert.equal(result.files.length, 4)
    assert.equal(result.skipped.length, 4)
    assert.ok(result.functions.some(item => item.file === 'data/static/codefixes/example.ts'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

const questions = {
  category: { type: 'choice', instructions: 'Evaluate state.function only', criteria: Object.fromEntries(labels.map(label => [label, label])) }
}
const model = 'jev-1.13.0'
const item = extractFunctions('example.ts', 'function example() { return 1 }').functions[0]

function answer (choice) {
  return { type: 'choice', choice, confidence: 1, probabilities: Object.fromEntries(labels.map(label => [label, Number(label === choice)])) }
}

function responseFor (choice = 'locally_protected') {
  return { model, answers: { category: answer(choice) }, usage: { input_tokens: 100, output_tokens: 20 } }
}

test('request cache is invalidated by changes to source, questions, model, or location', () => {
  const original = requestKey(item, questions, model)
  assert.notEqual(original, requestKey({ ...item, function: '() => 2' }, questions, model))
  assert.notEqual(original, requestKey({ ...item, id: 'moved.ts:0-32' }, questions, model))
  assert.notEqual(original, requestKey(item, { ...questions, another: questions.category }, model))
  assert.notEqual(original, requestKey(item, questions, 'jev-1.14.0'))
})

test('validates the rubric and rejects malformed responses', () => {
  assert.equal(validateQuestions(questions), questions)
  assert.throws(() => validateQuestions({ category: { type: 'score' } }))
  assert.equal(validateResponse(responseFor(), questions, model).model, model)
  const invalid = [
    { ...responseFor(), model: 'other' },
    { ...responseFor(), answers: {} },
    { ...responseFor(), usage: { input_tokens: -1, output_tokens: 0 } },
    { ...responseFor(), answers: { category: { ...answer('local_defect'), confidence: 2 } } },
    { ...responseFor(), answers: { category: { ...answer('local_defect'), choice: 'not_applicable' } } },
    { ...responseFor(), answers: { category: { ...answer('local_defect'), probabilities: { ...answer('local_defect').probabilities, not_applicable: 1 } } } }
  ]
  for (const response of invalid) assert.throws(() => validateResponse(response, questions, model), /invalid_response/)
})

test('accepts rounded probability totals without mutating API evidence', () => {
  for (const total of [0.98, 0.99, 1, 1.01, 1.02]) {
    const response = responseFor('not_applicable')
    response.answers.category.probabilities = {
      context_required: 0.04,
      local_defect: 0.02,
      locally_protected: 0,
      not_applicable: Number((total - 0.06).toFixed(2))
    }
    const original = structuredClone(response)
    assert.equal(validateResponse(response, questions, model), response)
    assert.deepEqual(response, original)
  }
  const invalid = responseFor('not_applicable')
  invalid.answers.category.probabilities.not_applicable = 0.97
  assert.throws(() => validateResponse(invalid, questions, model), /invalid_response/)
})

test('sends only comment-stripped source and all questions to the fixed HTTPS endpoint', async () => {
  const commented = extractFunctions('example.ts', 'function example() { /* SECRET_HINT */ return "https://example.test" }').functions[0]
  const client = createJevClient('test-credential', {
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://api.typesafe.ai/v1/systemone')
      assert.equal(options.redirect, 'error')
      assert.equal(new Headers(options.headers).get('authorization'), 'Bearer test-credential')
      assert.deepEqual(JSON.parse(options.body), { state: { function: commented.sanitizedFunction }, questions, model })
      assert.ok(!options.body.includes('SECRET_HINT'))
      assert.ok(options.body.includes('https://example.test'))
      return Response.json(responseFor())
    }
  })
  const result = await evaluate(commented, questions, model, client)
  assert.equal(result.answers.category.choice, 'locally_protected')
})

test('masks comments while preserving literals, templates, token boundaries, and line terminators', () => {
  const source = [
    'function example(input: string) {',
    '  /** DOC_HINT @param input TYPE_HINT */',
    '  const url = "https://example.test/*literal*/" // LINE_HINT',
    '  const matcher = /[/*]https?:\\/\\//g /* REGEX_HINT */',
    '  const template = `literal // /* ${input /* EXPR_HINT */} tail /* raw */`',
    '  const nested = `outer ${`inner ${input /* NESTED_HINT */} // literal`} /* literal */`',
    '  const divide = input.length / 2 /* DIVIDE_HINT */ / 3',
    '  let number = 1; number +/* TOKEN_HINT */+number',
    '  return /* MULTILINE_HINT\r\nSECOND_HINT\u2028THIRD_HINT\u2029END_HINT */',
    '  { url, matcher, template, nested, divide }',
    '}'
  ].join('\r\n')
  const extracted = extractFunctions('comments.ts', source)
  assert.deepEqual(extracted.diagnostics, [])
  const result = extracted.functions[0]
  assert.equal(result.function, source)
  assert.equal(result.sanitizedFunction.length, source.length)
  assert.ok(!result.sanitizedFunction.includes('_HINT'))
  assert.equal(result.removedCommentCount, 8)
  assert.equal(result.sanitizerVersion, sanitizerVersion)
  assert.equal(result.sanitizedSourceHash, hash(result.sanitizedFunction))
  assert.notEqual(result.sourceHash, result.sanitizedSourceHash)
  assert.ok(result.sanitizedFunction.includes('"https://example.test/*literal*/"'))
  assert.ok(result.sanitizedFunction.includes('/[/*]https?:\\/\\//g'))
  assert.ok(result.sanitizedFunction.includes(' tail /* raw */'))
  assert.ok(result.sanitizedFunction.includes(' // literal`} /* literal */'))
  assert.match(result.sanitizedFunction, /number \+ +\+number/)
  for (let offset = 0; offset < source.length; offset++) {
    if (/[\r\n\u2028\u2029]/.test(source[offset])) assert.equal(result.sanitizedFunction[offset], source[offset])
    else assert.ok(result.sanitizedFunction[offset] === source[offset] || result.sanitizedFunction[offset] === ' ')
  }
  assert.deepEqual(extractFunctions('comments.ts', result.sanitizedFunction).diagnostics, [])
})

test('preserves JSX text and attributes while removing comments inside JSX expressions', () => {
  const source = 'const View = () => <div title="/* literal */">// literal\n/* literal */{ /* JSX_HINT */ value }<span>{() => { // CALLBACK_HINT\n return "/* literal */" }}</span></div>'
  const extracted = extractFunctions('view.tsx', source)
  assert.deepEqual(extracted.diagnostics, [])
  assert.equal(extracted.functions.length, 2)
  const result = extracted.functions[0]
  assert.ok(!result.sanitizedFunction.includes('_HINT'))
  assert.equal(result.removedCommentCount, 2)
  assert.ok(result.sanitizedFunction.includes('title="/* literal */">// literal\n/* literal */'))
  assert.ok(result.sanitizedFunction.includes('return "/* literal */"'))
})

test('uses full-file context for methods and rejects raw or outdated request records', () => {
  const source = 'class Example { /** OUTSIDE_HINT */ method() { /* INSIDE_HINT */ return 1 } }'
  const result = extractFunctions('method.ts', source).functions[0]
  assert.equal(result.name, 'method')
  assert.equal(result.removedCommentCount, 1)
  assert.ok(!requestFor(result, questions, model).state.function.includes('_HINT'))
  assert.throws(() => requestFor({ function: source }, questions, model), /missing_sanitized_source/)
  assert.throws(() => requestFor({ ...result, sanitizerVersion: 'old' }, questions, model), /missing_sanitized_source/)
  const legacyKey = hash(JSON.stringify({ version: 1, id: result.id, request: { state: { function: result.function }, model, questions } }))
  assert.notEqual(requestKey(result, questions, model), legacyKey)
})

test('SDK retries transient HTTP failures with a bounded attempt count', async () => {
  let calls = 0
  const client = createJevClient('test-credential', {
    fetchImpl: async () => ++calls === 1
      ? new Response('', { status: 429, headers: { 'retry-after': '0' } })
      : Response.json(responseFor()),
    retry: { backoffInitialMs: 0, backoffMaxMs: 0 }
  })
  const result = await evaluate(item, questions, model, client)
  assert.equal(result.model, model)
  assert.equal(calls, 2)
  calls = 0
  const failingClient = createJevClient('test-credential', {
    fetchImpl: async () => { calls++; return new Response('', { status: 529 }) },
    retry: { backoffInitialMs: 0, backoffMaxMs: 0 }
  })
  await assert.rejects(evaluate(item, questions, model, failingClient), /http_529/)
  assert.equal(calls, 4)
})

test('does not transmit without credentials or expose API error bodies', async () => {
  assert.throws(() => createJevClient('', {
    fetchImpl: async () => { assert.fail('No request should be made') }
  }), /missing_api_key/)
  const client = createJevClient('test-credential', {
    fetchImpl: async () => new Response('sensitive server error', { status: 401 })
  })
  await assert.rejects(evaluate(item, questions, model, client), { message: 'http_401' })
})

test('keeps protected functions and separates relevance from defect and context evidence', () => {
  const items = labels.map(label => ({ ...item, id: label }))
  const records = new Map(labels.map(label => [label, { status: 'evaluated', response: responseFor(label) }]))
  const ranked = rankFunctions(items, records)
  assert.deepEqual(ranked.map(record => record.id), ['local_defect', 'context_required', 'locally_protected', 'not_applicable'])
  const protectedFunction = ranked.find(record => record.id === 'locally_protected')
  assert.equal(protectedFunction.relevance, 1)
  assert.equal(protectedFunction.defectEvidence, 0)
  assert.equal(ranked.find(record => record.id === 'context_required').contextNeeded, 1)
  assert.equal(ranked.at(-1).relevance, 0)
})

test('runner writes a full inventory, resumes successful calls, and invalidates changed source', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'jev-runner-'))
  try {
    const root = path.join(workspace, 'repo')
    const output = path.join(workspace, 'output')
    const questionsPath = path.join(workspace, 'questions.json')
    await mkdir(root)
    await writeFile(path.join(root, 'example.ts'), 'function one() {}\nconst two = () => 2')
    await writeFile(questionsPath, JSON.stringify(questions))
    let calls = 0
    const client = { systemOne: async () => { calls++; return responseFor() } }
    const options = { root, output, questionsPath, model, concurrency: 2 }
    const first = await runAnalysis(options, { client })
    assert.equal(first.status, 'complete')
    assert.equal(first.sanitizerVersion, sanitizerVersion)
    assert.equal(first.evaluated, 2)
    assert.equal(calls, 2)
    const report = await readFile(path.join(output, 'report.md'), 'utf8')
    assert.ok(report.includes('locally_protected'))
    const second = await runAnalysis(options, { client })
    assert.equal(second.reused, 2)
    assert.equal(second.newInputTokens, 0)
    assert.equal(calls, 2)
    await writeFile(path.join(root, 'example.ts'), 'function one() {}\nconst two = () => 3')
    const third = await runAnalysis(options, { client })
    assert.equal(third.reused, 1)
    assert.equal(calls, 3)
    const ranked = JSON.parse(await readFile(path.join(output, 'ranked.json'), 'utf8'))
    assert.equal(ranked.length, 2)
    assert.ok(ranked.every(record => record.relevance === 1 && record.defectEvidence === 0))
    assert.ok(ranked.every(record => record.sanitizerVersion === sanitizerVersion && record.sanitizedSourceHash))
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test('runner records missing credentials and failures instead of fabricating rankings', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'jev-failure-'))
  try {
    const root = path.join(workspace, 'repo')
    const questionsPath = path.join(workspace, 'questions.json')
    await mkdir(root)
    await writeFile(path.join(root, 'example.ts'), 'function one() {}\nfunction two() {}')
    await writeFile(questionsPath, JSON.stringify(questions))
    const options = { root, questionsPath, output: path.join(workspace, 'output'), apiKey: '', concurrency: 1 }
    const missing = await runAnalysis(options)
    assert.equal(missing.blockReason, 'missing_api_key')
    assert.equal(missing.pending, 2)
    assert.equal(missing.evaluationCompleteForSelection, false)
    const ranked = JSON.parse(await readFile(path.join(options.output, 'ranked.json'), 'utf8'))
    assert.deepEqual(ranked, [])
    const client = createJevClient('test-credential', { fetchImpl: async () => new Response('', { status: 401 }) })
    const failed = await runAnalysis(options, { client })
    assert.equal(failed.failed, 1)
    assert.equal(failed.pending, 1)
    assert.equal(failed.blockReason, 'http_401')
    assert.equal(failed.evaluated, 0)
    const dryRun = await runAnalysis({ ...options, inventoryOnly: true })
    assert.equal(dryRun.status, 'inventory_only')
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

const classificationQuestions = {
  operation_database_query: {
    type: 'choice', instructions: 'Evaluate state.function for data queries',
    criteria: { present: 'Visible query', absent: 'No visible query', unclear: 'Unresolved query semantics' }
  },
  context_input_provenance: {
    type: 'choice', instructions: 'Evaluate missing input provenance in state.function',
    criteria: { present: 'Material missing provenance', absent: 'No provenance gap', unclear: 'Relevance unresolved' }
  },
  guard_failure_behavior: {
    type: 'choice', instructions: 'Evaluate local guard flow in state.function',
    criteria: { not_applicable: 'No related guard', blocked_on_shown_failures: 'Guard blocks operation', continues_on_a_shown_path: 'Guard failure continues', unclear: 'Flow unresolved' }
  }
}

function classificationResponse () {
  const choices = ['present', 'unclear', 'blocked_on_shown_failures']
  return {
    model,
    answers: Object.fromEntries(Object.entries(classificationQuestions).map(([name, question], index) => [name, {
      type: 'choice', choice: choices[index], confidence: 1,
      probabilities: Object.fromEntries(Object.keys(question.criteria).map(label => [label, Number(label === choices[index])]))
    }])),
    usage: { input_tokens: 100, output_tokens: 20 }
  }
}

test('validates both rubric modes and per-question answer labels', async () => {
  assert.equal(questionMode(questions), 'defects')
  assert.equal(questionMode(classificationQuestions), 'classification')
  const actual = JSON.parse(await readFile(new URL('./questions.json', import.meta.url), 'utf8'))
  assert.equal(Object.keys(actual).length, 43)
  assert.equal(questionMode(actual), 'classification')
  assert.throws(() => questionMode({ ...classificationQuestions, ...questions }), /mixed/)
  const response = classificationResponse()
  assert.equal(validateResponse(response, classificationQuestions, model), response)
  const rounded = structuredClone(response)
  rounded.answers.operation_database_query.probabilities.present = 0.99
  validateResponse(rounded, classificationQuestions, model)
  rounded.answers.operation_database_query.probabilities.present = 0.98
  assert.throws(() => validateResponse(rounded, classificationQuestions, model), /invalid_response/)
  response.answers.operation_database_query = answer('local_defect')
  assert.throws(() => validateResponse(response, classificationQuestions, model), /invalid_response/)
})

test('classification preserves every answer and provenance without defect rankings', () => {
  const response = classificationResponse()
  const records = new Map([[item.id, { status: 'evaluated', response, evaluatedAt: '2026-09-21T00:00:00.000Z' }]])
  const result = classifyFunctions([item, { ...item, id: 'pending' }], records, classificationQuestions, model)
  assert.equal(result.length, 1)
  assert.deepEqual(result[0].answers, response.answers)
  assert.deepEqual(result[0].presentCategories, ['operation_database_query'])
  assert.deepEqual(result[0].unclearCategories, ['context_input_provenance'])
  assert.equal(result[0].guardFailureBehavior, 'blocked_on_shown_failures')
  assert.equal(result[0].requestKey, requestKey(item, classificationQuestions, model))
  assert.equal(result[0].questionsHash, hash(JSON.stringify(classificationQuestions)))
  assert.ok(!Object.hasOwn(result[0], 'reviewRank'))
  assert.ok(!Object.hasOwn(result[0], 'defectEvidence'))
  assert.ok(!Object.hasOwn(result[0], 'sanitizedFunction'))
})

test('classification runner saves exact rubric and results, resumes, and protects other experiments', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'jev-classifier-'))
  try {
    const root = path.join(workspace, 'repo')
    const output = path.join(workspace, 'output')
    const questionsPath = path.join(workspace, 'questions.json')
    await mkdir(root)
    await writeFile(path.join(root, 'example.ts'), 'function example(value) { /* hint */ return value }')
    await writeFile(questionsPath, JSON.stringify(classificationQuestions))
    let calls = 0
    const client = { systemOne: async request => {
      calls++
      assert.deepEqual(request.questions, classificationQuestions)
      assert.ok(!request.state.function.includes('hint'))
      return classificationResponse()
    } }
    const options = { root, output, questionsPath, model }
    const first = await runAnalysis(options, { client })
    assert.equal(first.mode, 'classification')
    assert.equal(first.resultFile, 'classifications.json')
    assert.equal(first.status, 'complete')
    assert.ok(first.elapsedSeconds >= 0)
    const saved = JSON.parse(await readFile(path.join(output, 'classifications.json'), 'utf8'))
    assert.equal(saved.length, 1)
    assert.deepEqual(saved[0].answers, classificationResponse().answers)
    assert.ok(!Object.hasOwn(saved[0], 'defectEvidence'))
    await assert.rejects(readFile(path.join(output, 'ranked.json')), { code: 'ENOENT' })
    assert.deepEqual(JSON.parse(await readFile(path.join(output, 'questions.snapshot.json'), 'utf8')), classificationQuestions)
    const resumed = await runAnalysis(options, { client })
    assert.equal(resumed.reused, 1)
    assert.equal(calls, 1)
    const originalSummary = await readFile(path.join(output, 'summary.json'), 'utf8')
    await writeFile(questionsPath, JSON.stringify(questions))
    await assert.rejects(runAnalysis(options, { client }), /different experiment/)
    assert.equal(await readFile(path.join(output, 'summary.json'), 'utf8'), originalSummary)
    assert.equal(calls, 1)
    await assert.rejects(readFile(path.join(output, '.lock')), { code: 'ENOENT' })
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})