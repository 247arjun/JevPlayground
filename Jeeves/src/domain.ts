import { z } from 'zod'

export const digestSchema = z.string().regex(/^[a-f0-9]{64}$/)
export const locationSchema = z.object({ offset: z.number().int().nonnegative(), line: z.number().int().positive(), column: z.number().int().positive() })
export const answerSchema = z.object({
  type: z.literal('choice'), choice: z.string().min(1), confidence: z.number().min(0).max(1),
  probabilities: z.record(z.string(), z.number().min(0).max(1))
})
export const functionSchema = z.object({
  id: z.string().min(1).max(2048), file: z.string().min(1).max(1024), name: z.string().max(8192),
  kind: z.string(), parentId: z.string().nullable(), start: locationSchema, end: locationSchema,
  sourceHash: digestSchema, sanitizedSourceHash: digestSchema,
  sanitizerVersion: z.string().min(1), function: z.string(), sanitizedFunction: z.string(),
  parseDiagnostics: z.array(z.unknown()).default([])
}).passthrough()
export const classificationSchema = z.object({
  id: z.string(), file: z.string(), sourceHash: digestSchema, sanitizedSourceHash: digestSchema,
  model: z.string(), questionsHash: digestSchema.optional(), answers: z.record(z.string(), answerSchema)
}).passthrough()
export const questionsSchema = z.record(z.string(), z.object({
  type: z.literal('choice'), instructions: z.unknown(), criteria: z.record(z.string(), z.string())
}))
export type FunctionRecord = z.infer<typeof functionSchema>
export type Classification = z.infer<typeof classificationSchema>
export type Questions = z.infer<typeof questionsSchema>

export function validateAnswers (record: Classification, questions: Questions): void {
  if (Object.keys(record.answers).length !== Object.keys(questions).length) throw new Error('answer_count_mismatch')
  for (const [name, question] of Object.entries(questions)) {
    const answer = record.answers[name]
    const labels = Object.keys(question.criteria)
    if (!answer || !labels.includes(answer.choice) || labels.length !== Object.keys(answer.probabilities).length ||
        !labels.every(label => Object.hasOwn(answer.probabilities, label))) throw new Error('answer_labels_mismatch')
    const probabilities = Object.values(answer.probabilities)
    if (Math.abs(probabilities.reduce((sum, value) => sum + value, 0) - 1) > labels.length * 0.005 + 1e-9 ||
        (answer.probabilities[answer.choice] ?? -1) + 1e-9 < Math.max(...probabilities)) throw new Error('invalid_probabilities')
  }
}

export const citationSchema = z.object({
  file: z.string(), start: z.number().int().nonnegative(), end: z.number().int().positive(), sourceHash: digestSchema
}).strict()
export type Citation = z.infer<typeof citationSchema>
export const dispositionSchema = z.enum(['no_relevant_operation', 'needs_context', 'supported_candidate', 'refuted_hypothesis', 'budget_exhausted'])
export const resultSchema = z.object({
  disposition: dispositionSchema,
  summary: z.string().min(1).max(8000),
  operation: citationSchema.nullable(),
  invariant: z.string().max(4000),
  facts: z.array(z.object({ text: z.string().max(4000), citations: z.array(citationSchema).min(1).max(10) }).strict()).max(30),
  assumptions: z.array(z.string().max(2000)).max(20),
  counterevidence: z.array(z.object({ text: z.string().max(4000), citations: z.array(citationSchema).min(1).max(10) }).strict()).max(20),
  unresolved: z.array(z.string().max(2000)).max(20)
}).strict()
export type AgentResult = z.infer<typeof resultSchema>
export type Role = 'localizer' | 'investigator' | 'challenger'
export type Row = Record<string, string | number | null>

export const limitsSchema = z.object({
  maxFileBytes: z.number().int().min(1024).max(64 * 1024 * 1024).default(16 * 1024 * 1024),
  pageSize: z.number().int().min(1).max(200).default(50),
  maxResultBytes: z.number().int().min(1024).max(1024 * 1024).default(96 * 1024),
  maxToolCalls: z.number().int().min(1).max(100).default(40),
  maxModelCalls: z.number().int().min(1).max(1000).default(75),
  modelTimeoutMs: z.number().int().min(1000).max(600000).default(120000),
  compilerTimeoutMs: z.number().int().min(1000).max(120000).default(30000),
  compilerMemoryMb: z.number().int().min(128).max(8192).default(512),
  maxQueue: z.number().int().min(1).max(100).default(16)
}).strict()
export type Limits = z.infer<typeof limitsSchema>
export const defaultLimits = limitsSchema.parse({})