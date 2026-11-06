import test from 'node:test'
import assert from 'node:assert/strict'
import { administrative, ownedExecutionChain, unresolvedWork, incompleteDisposition } from '../work-policy.mjs'
const agent = { id: 'fixture' }
function execution(callId, rootCallId = callId, parent) { return { agent, callId, rootCallId, token: Object.freeze({ callId }), ...(parent ? { parent } : {}) } }
test('owned token ancestry excludes real root/middle but retains a sibling in the same root', () => {
  const root = execution('root'), middle = execution('middle', 'root', root.token), current = execution('finish', 'root', middle.token), sibling = execution('sibling', 'root', middle.token)
  const chain = ownedExecutionChain(current, [root, middle, current, sibling])
  assert.equal(chain.ancestors.size, 3); assert.deepEqual(chain.others, [sibling])
  const forged = { ...current, parent: Object.freeze({ callId: 'middle' }) }
  assert.throws(() => ownedExecutionChain(forged, [root, middle, forged]), error => error.code === 'OWNED_EXECUTION_PARENT_MISSING_OR_DUPLICATE')
})
test('UNKNOWN dispatch inside an excluded current root still blocks, independent of recent proofs', () => {
  const state = { acknowledgedWork: [], uncertainties: [], calls: { root: { seq: 11, tool: 'run_code', eventDigest: 'a'.repeat(64) } },
    dispatches: [{ rootCallId: 'root', seq: 12, tool: 'fixture_action', outcome: 'UNKNOWN' }], proofs: [] }
  assert.equal(unresolvedWork(state, { beginResultSeq: 10 }, new Set(['root'])).length, 1)
})
test('names never exempt UNKNOWN or pending work, including goal mutation and graph-like custom tools', () => {
  assert.equal(administrative('transaction_graph_external'), false)
  assert.equal(administrative('update_goal'), false)
  assert.equal(administrative('transaction_graph_read'), true)
  for (const tool of ['transaction_graph_external', 'update_goal', 'transaction_graph_read']) {
    const state = { acknowledgedWork: [], uncertainties: [], calls: { root: { seq: 11, tool, eventDigest: 'a'.repeat(64) } }, dispatches: [] }
    assert.equal(unresolvedWork(state, { beginResultSeq: 10 }).length, 1)
    state.dispatches = [{ rootCallId: 'root', seq: 12, tool, outcome: 'UNKNOWN' }]
    assert.equal(unresolvedWork(state, { beginResultSeq: 10 }, new Set(['root'])).length, 1)
  }
})
test('incomplete cannot label NOT_RUN as executed failure or an executed step as zero-work skip', () => {
  const activeProof = { workStartedAtBegin: 0, workExecutedAtBegin: 0 }
  const notRun = { kind: 'tool_result', ownOutcome: 'NOT_RUN', isError: false, qualification: 'FAILED', ancestorOutcomes: [] }
  assert.throws(() => incompleteDisposition({ requested: 'FAILED', state: { workStarted: 1, workExecuted: 0 }, activeProof, evidence: [notRun] }), error => error.code === 'FAILED_DISPOSITION_REQUIRES_KNOWN_TERMINAL_FAILURE')
  assert.equal(incompleteDisposition({ requested: 'SKIPPED_NOT_RUN', state: { workStarted: 1, workExecuted: 0 }, activeProof, evidence: [notRun] }), 'SKIPPED_NOT_RUN')
  assert.throws(() => incompleteDisposition({ requested: 'SKIPPED_NOT_RUN', state: { workStarted: 1, workExecuted: 1 }, activeProof, evidence: [] }), error => error.code === 'NOT_RUN_DISPOSITION_CANNOT_HIDE_EXECUTED_WORK')
})
