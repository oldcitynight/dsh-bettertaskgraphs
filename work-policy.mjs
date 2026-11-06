// SPDX-License-Identifier: GPL-3.0-only
import { GraphError, canonical } from './core.mjs'
const fail = code => { throw new GraphError(code) }
export const workKey = row => `${row.rootCallId ?? row.callId}:${row.callSeq ?? row.seq}`
// Only this protocol's exact five names are non-work for count/disposition.
// UNKNOWN/PENDING tracking deliberately has no name-based exemption.
const protocolNames = new Set(['transaction_graph_read', 'transaction_graph_create', 'transaction_graph_begin', 'transaction_graph_finish', 'transaction_graph_skip'])
export const administrative = name => protocolNames.has(name)

// ToolExecution.parent/token are registry-owned identities, never call-name guesses.
export function ownedExecutionChain(exec, running) {
  const rows = [...running], ancestors = new Set(), callIds = new Set()
  let cursor = exec
  for (let depth = 0; depth <= 32; depth++) {
    const exact = rows.filter(row => row.token === cursor.token && row.callId === cursor.callId)
    if (!cursor.token || exact.length !== 1 || exact[0].agent !== exec.agent || exact[0].rootCallId !== exec.rootCallId
        || ancestors.has(cursor.token)) fail('OWNED_EXECUTION_ANCESTRY_UNAVAILABLE')
    cursor = exact[0]; ancestors.add(cursor.token); callIds.add(cursor.callId)
    if (cursor.parent === undefined) {
      if (cursor.callId !== exec.rootCallId) fail('OWNED_EXECUTION_ROOT_MISMATCH')
      const others = rows.filter(row => !ancestors.has(row.token))
      return { ancestors, callIds, others }
    }
    const parent = rows.filter(row => row.token === cursor.parent)
    if (parent.length !== 1) fail('OWNED_EXECUTION_PARENT_MISSING_OR_DUPLICATE')
    cursor = parent[0]
  }
  fail('OWNED_EXECUTION_DEPTH_LIMIT')
}

export function unresolvedWork(state, activeProof, excludedCallIds = new Set()) {
  if (!activeProof) return []
  const acknowledged = new Set(state.acknowledgedWork.map(workKey)), result = new Map()
  for (const row of state.uncertainties) {
    if (!acknowledged.has(workKey(row)) && (row.rootResultSeq > activeProof.beginResultSeq || row.callSeq > activeProof.beginResultSeq))
      result.set(workKey(row), { ...row, state: 'UNKNOWN' })
  }
  // A settled UNKNOWN child cannot hide inside the current read/finish root,
  // whose own result has not yet committed. Do not wait for proof-index entry.
  for (const row of state.dispatches) {
    const root = state.calls[row.rootCallId]
    if (root && row.outcome === 'UNKNOWN' && row.seq > activeProof.beginResultSeq) {
      const work = { rootCallId: row.rootCallId, callSeq: root.seq, rootResultSeq: null, eventDigest: root.eventDigest }
      if (!acknowledged.has(workKey(work))) result.set(workKey(work), { ...work, state: 'UNKNOWN' })
    }
  }
  for (const [callId, row] of Object.entries(state.calls)) {
    const work = { rootCallId: callId, callSeq: row.seq, rootResultSeq: null, eventDigest: row.eventDigest }
    if (row.seq > activeProof.beginResultSeq && !excludedCallIds.has(callId) && !acknowledged.has(workKey(work)))
      result.set(workKey(work), { ...work, state: 'PENDING' })
  }
  return [...result.values()]
}

const failedFact = fact => fact.outcome === 'FAIL' || fact.isError === true && fact.outcome === 'UNVERIFIED'
export const knownFailure = proof => failedFact({ outcome: proof.ownOutcome, isError: proof.isError })
  || proof.ancestorOutcomes.some(failedFact)
export const notRunFact = proof => proof.ownOutcome === 'NOT_RUN' || proof.ancestorOutcomes.some(row => row.outcome === 'NOT_RUN')

export function incompleteDisposition({ requested, state, activeProof, evidence }) {
  if (!['SKIPPED_NOT_RUN', 'UNSATISFIED', 'FAILED'].includes(requested)) fail('EXPLICIT_INCOMPLETE_DISPOSITION_REQUIRED')
  if (!activeProof) fail('ACTIVE_BEGIN_PROOF_REQUIRED')
  const facts = evidence.filter(row => row.kind !== 'artifact')
  if (facts.some(row => row.qualification === 'UNKNOWN' || row.ownOutcome === 'UNKNOWN')) fail('UNKNOWN_EVIDENCE_REQUIRES_TRUSTED_RECONCILIATION')
  if (requested === 'FAILED' && !facts.some(knownFailure)) fail('FAILED_DISPOSITION_REQUIRES_KNOWN_TERMINAL_FAILURE')
  if (requested === 'SKIPPED_NOT_RUN') {
    const zeroWork = state.workStarted === activeProof.workStartedAtBegin
    const noneExecuted = state.workExecuted === activeProof.workExecutedAtBegin
    if (!noneExecuted || facts.some(knownFailure) || !zeroWork && !facts.some(notRunFact)) fail('NOT_RUN_DISPOSITION_CANNOT_HIDE_EXECUTED_WORK')
  }
  return requested
}

export function sameWorkSnapshot(a, b) { return canonical(a) === canonical(b) }
