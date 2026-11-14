// SPDX-License-Identifier: GPL-3.0-only
// Shared by the Host registration and the lazy browser module.
export function createRemoteContribution(z) {
  const packageName = 'dsh-better-task-grapth'
  const id = z.string().min(1).max(128)
  const node = z.object({
    id, label: z.string().min(1).max(512), kind: z.enum(['container', 'leaf']),
    parent: id.nullable(),
    status: z.enum(['COMPLETE', 'CONTAINER_INCOMPLETE', 'ACTIVE', 'INACTIVE', 'INCOMPLETE', 'PENDING', 'SKIPPED']),
    blocked: z.literal(true).optional(),
    disposition: z.enum(['COMPLETED', 'SKIPPED_NOT_RUN', 'UNSATISFIED', 'FAILED']).optional(),
    branchState: z.enum(['SELECTED', 'WAITING', 'NOT_SELECTED']).optional(),
    selectedBranch: z.object({
      outcome: z.enum(['complete', 'incomplete']), case: z.string().min(1).max(64).optional(), targetId: id.optional(),
    }).strict().optional(),
  }).strict()
  const edge = z.discriminatedUnion('kind', [
    z.object({ from: id, to: id, kind: z.literal('prerequisite') }).strict(),
    z.object({ from: id, to: id, kind: z.literal('route'), outcome: z.enum(['complete', 'incomplete']) }).strict(),
    z.object({ from: id, to: id, kind: z.literal('case'), case: z.string().min(1).max(64) }).strict(),
  ])
  const choice = z.object({ id, choice: z.number().int().min(0).max(127) }).strict()
  const graph = z.object({
    revision: z.number().int().min(1).max(1024), title: z.string().min(1).max(512),
    nodes: z.array(node).min(2).max(128), edges: z.array(edge).max(512),
    active: z.object({ nodeId: id, recoveryRequired: z.boolean() }).strict().nullable(),
    pending: z.object({ operation: z.string().min(1).max(64), qualification: z.string().min(1).max(128) }).strict().nullable(),
    legalNext: z.array(choice).max(128), skipChoices: z.array(choice).max(128),
  }).strict()
  const output = z.discriminatedUnion('status', [
    z.object({ sessionId: id, status: z.literal('ready'), graph }).strict(),
    z.object({ sessionId: id, status: z.literal('empty'), graph: z.null() }).strict(),
    z.object({ sessionId: id, status: z.literal('unavailable'), graph: z.null() }).strict(),
  ])
  const codec = (key, schema) => ({ mode: 'strict', typeSymbol: `${packageName}#${key}`, create: () => schema })
  return {
    package: packageName,
    descriptors: [{
      id: `${packageName}#transactionGraphView/status`,
      service: 'transactionGraph', namespace: 'transactionGraphView', method: 'status', invocation: { kind: 'direct' },
      parameters: [{
        name: 'session', wire: 'sessionId', source: 'lookup', lookup: 'session',
        codec: { mode: 'strict', typeSymbol: '@deepseek-ai/dsh-session/types#SessionId', create: () => id },
      }],
      cancellation: { parameter: 'signal' },
      result: codec('TransactionGraphStatusResult', output),
    }],
  }
}
