import path from 'node:path'
import ts from 'typescript'
import type { Store } from '../storage/store.js'
import { readBounded } from '../security.js'
import { defaultLimits } from '../domain.js'

export function pathPurpose (file: string): { purpose: string, reasons: string[] } {
  if (/(^|\/)(tests?|__tests__|fixtures|__fixtures__|mocks|__mocks__|codefixes|testdata)(\/|$)|\.(test|spec|stories)\./i.test(file)) return { purpose: 'test_or_fixture', reasons: ['fixture_or_test_path'] }
  if (/(^|\/)(examples|docker-examples|tools|scripts)(\/|$)|(^|\/)(cypress|playwright|vitest|jest|eslint|webpack|vite)\.config\./i.test(file)) return { purpose: 'example_or_tooling', reasons: ['tooling_or_example_path'] }
  if (/(^|\/)(vendor|vendors|third_party|third-party)(\/|$)|\.min\.[cm]?js$/i.test(file)) return { purpose: 'vendor', reasons: ['vendor_or_minified_path'] }
  if (/(^|\/)(seeds?|migrations|startup|initialization)(\/|$)/i.test(file)) return { purpose: 'initialization', reasons: ['initialization_path'] }
  return { purpose: 'application_candidate', reasons: ['runtime_role_not_established'] }
}

export async function recordPurposes (store: Store, root: string): Promise<void> {
  const configurations: Array<{ directory: string, file: string, exclusions: string[] }> = []
  for await (const file of store.scan('files')) {
    if (!/(^|\/)tsconfig[^/]*\.json$/.test(String(file.path))) continue
    const parsed = ts.parseConfigFileTextToJson(String(file.path), (await readBounded(root, String(file.path), defaultLimits.maxFileBytes)).toString())
    if (!parsed.error && Array.isArray(parsed.config?.exclude)) configurations.push({ directory: path.posix.dirname(String(file.path)), file: String(file.path), exclusions: parsed.config.exclude.filter((value: unknown) => typeof value === 'string') })
  }
  for await (const file of store.scan('files')) {
    const relative = String(file.path)
    const classification = pathPurpose(relative)
    const excludedBy = configurations.filter(config => {
      const local = path.posix.relative(config.directory, relative)
      if (local.startsWith('../')) return false
      return config.exclusions.some(pattern => path.posix.matchesGlob(local, pattern) || path.posix.matchesGlob(local, `${pattern}/**`))
    }).map(config => config.file)
    await store.execute('INSERT OR REPLACE INTO file_context VALUES (?,?,?)', [relative, classification.purpose, JSON.stringify({ ...classification, excludedBy, capability: 'declared_only', caveats: ['Path labels and project exclusions do not prove runtime reachability or its absence.', 'Inherited and dynamic build configuration is not evaluated.'] })])
    await store.execute('UPDATE functions SET purpose=? WHERE file=?', [classification.purpose, relative])
  }
}