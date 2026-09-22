import ts from 'typescript'

const sdkFamilies: Record<string, string> = {
  '@azure/identity': 'workload_identity', '@azure/keyvault-secrets': 'key_vault_secret',
  '@azure/keyvault-keys': 'key_vault_key', '@azure/storage-blob': 'blob_storage',
  '@azure/cosmos': 'database', '@azure/service-bus': 'messaging', '@azure/event-hubs': 'messaging',
  '@azure/storage-queue': 'messaging', '@azure/functions': 'function_registration', express: 'http_registration'
}

export function frameworkEvidence (file: string, source: string): Record<string, unknown> {
  const facts: Array<Record<string, unknown>> = []
  const reasons: string[] = []
  if (/\.json$/.test(file)) {
    const parsed = ts.parseConfigFileTextToJson(file, source)
    if (parsed.error) return { facts, basis: 'declared', reasons: ['configuration_parse_error'] }
    const value = parsed.config as Record<string, unknown>
    if (Array.isArray(value.bindings)) {
      for (const binding of value.bindings) {
        if (!binding || typeof binding !== 'object') continue
        const fields = binding as Record<string, unknown>
        facts.push({ kind: 'function_binding', type: fields.type, direction: fields.direction, name: fields.name,
          connectionSettingName: fields.connection, queueName: fields.queueName, topicName: fields.topicName,
          limitation: 'Setting names and resource declarations are not observed deployment identity or authorization.' })
      }
    }
    if (Array.isArray(value.resources)) {
      const visit = (resources: unknown[], depth: number) => {
        if (depth > 20 || facts.length >= 200) { reasons.push('resource_budget'); return }
        for (const resource of resources) {
          if (!resource || typeof resource !== 'object') continue
          const fields = resource as Record<string, unknown>
          facts.push({ kind: 'declared_resource', type: fields.type, name: fields.name, identityType: (fields.identity as Record<string, unknown> | undefined)?.type })
          if (Array.isArray(fields.resources)) visit(fields.resources, depth + 1)
        }
      }
      visit(value.resources, 0)
    }
  } else if (/\.[cm]?[jt]sx?$/.test(file)) {
    const syntax = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
    const bindings = new Map<string, string>()
    for (const node of syntax.statements) {
      if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) continue
      const family = sdkFamilies[node.moduleSpecifier.text]
      if (!family) continue
      facts.push({ kind: 'sdk_import', family, module: node.moduleSpecifier.text, start: node.getStart(syntax), end: node.getEnd() })
      if (node.importClause?.name) bindings.set(node.importClause.name.text, family)
      const named = node.importClause?.namedBindings
      if (named && ts.isNamedImports(named)) for (const binding of named.elements) bindings.set(binding.name.text, family)
      if (named && ts.isNamespaceImport(named)) bindings.set(named.name.text, family)
    }
    const walk = (node: ts.Node) => {
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        let receiver = node.expression
        while (ts.isPropertyAccessExpression(receiver)) receiver = receiver.expression
        const family = ts.isIdentifier(receiver) ? bindings.get(receiver.text) : undefined
        if (family) facts.push({ kind: 'import_linked_invocation', family, start: node.getStart(syntax), end: node.getEnd(), expression: node.expression.getText(syntax) })
      }
      ts.forEachChild(node, walk)
    }
    walk(syntax)
  } else {
    reasons.push('configuration_format_requires_language_adapter')
  }
  return { modelVersion: 'azure-declared-v1', file, basis: 'declared', facts: facts.slice(0, 200), completion: 'partial', reasons: [...reasons, 'deployed_settings_unknown', 'sdk_import_does_not_prove_runtime_target', 'cross_service_identity_not_established'] }
}