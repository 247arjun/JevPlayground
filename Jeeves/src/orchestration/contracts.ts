const contracts: Record<string, string> = {
  'object-ownership': 'Identify the selected object and authenticated principal. Trace ownership enforcement across handler, middleware, datastore predicate and generated API. No authorization-decision signal does not establish safety; missing local enforcement does not disprove an external guard.',
  'endpoint-policy': 'Review the declared HTTP method, authentication, principal/object binding, input validation and response projection. Read relevant middleware in declaration order and the model/framework policy for generated endpoints. A registration is not proof of deployment.',
  'authentication-recovery': 'Review credential handling, recovery policy, throttling, session establishment and trust assumptions. Distinguish technically correct comparisons from the intended authentication policy and deployed enforcement.',
  'cryptography': 'Identify the purpose of the primitive and its actual inputs, key management and consumer. Distinguish password hashing, integrity, encryption and non-security checksums. A suspicious primitive without a security use is not automatically a defect.',
  'security-values': 'Trace generation through storage and consumption; establish freshness, unpredictability, integrity and lifecycle requirements from evidence.',
  'business-policy': 'Identify evidence for the intended invariant before assessing it. Follow issuance and redemption, input bounds, quantities, prices, balances and state transitions where relevant. Prompt text and descriptions are not enforcement; do not invent business requirements.',
  'rendering-context': 'Connect producer, persistence/service boundary, component and actual template binding. Distinguish escaped text, encoded attributes, HTML trust promotion and HTML sinks. Inspect local templates before claiming a dependency is the missing sink.',
  'query-structure': 'Determine whether external values influence interpreted query structure or only bound data operands, then inspect the actual query API and relevant guards.',
  'file-target': 'Compare the checked path with the used path, normalization order, ownership and containment. Account for configured authority and file-serving policy; do not infer a less-trusted actor without evidence.',
  'redirect-policy': 'Compare parsed destination origin/path policy with the actual navigation operation; distinguish a navigation target from a server-side outbound request.',
  'response-disclosure': 'Trace response/error serialization and field projection, including middleware. Distinguish application responses from server-side logging and evaluate the intended disclosure policy.',
  'dependency-security': 'Report dependency versions as inventory unless a reviewed advisory and applicable version/configuration evidence exist in the snapshot. Do not invent advisory IDs, current vulnerability status, reachability or exploitation.',
  'configuration-policy': 'Inspect parsed configuration together with consumers and deployment evidence. Treat secrets as sensitive evidence; do not reproduce their values. A declared setting is not proof of deployed enforcement.',
  'general-review': 'Review this otherwise unclassified subject for security-relevant producers, consumers and declared policy. Ordinary string/encoding operations may have authority-bearing consumers; search bounded callers and configuration before deciding relevance.'
}

export function reviewContract (theme: string): string {
  return contracts[theme] ?? 'Inspect the selected operation, its particular operands, producers, consumers and security invariant. Establish which controls apply on the relevant path and distinguish missing context from counterevidence.'
}