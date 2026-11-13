// SPDX-License-Identifier: GPL-3.0-only
import { FileGraphStore } from './store.mjs'
import { canonical, copy, digest, GraphError, validateDocument } from './core.mjs'
export const MAX_CLAIMS = 1024
const fail = code => { throw new GraphError(code) }
const integer = value => Number.isSafeInteger(value) && value >= 0
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const fields = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).every(key => keys.includes(key)) && keys.every(key => Object.hasOwn(value, key))
export function seal(value) { const body = copy(value); delete body.checksum; return { ...body, checksum: digest(body) } }
export function claimDigest(value) { const body = copy(value); delete body.claimDigest; delete body.intentSeq; return digest(body) }
export function initialJournal(binding) {
  return seal({ schema: 4, revision: 0, binding: copy(binding), document: null, activeProof: null, pending: null, claims: [] })
}
export function validateJournal(value, binding) {
  if (!fields(value, ['schema', 'revision', 'binding', 'document', 'activeProof', 'pending', 'claims', 'checksum'])
      || value.schema !== 4 || !integer(value.revision) || canonical(value.binding) !== canonical(binding)
      || !hex(value.checksum) || seal(value).checksum !== value.checksum || !Array.isArray(value.claims) || value.claims.length > MAX_CLAIMS)
    fail('JOURNAL_SCOPE_CHECKSUM_OR_LIMIT')
  if (value.document) validateDocument(value.document)
  const operations = new Set()
  for (const row of value.claims) {
    if (!fields(row, ['operationId', 'payloadHash', 'status', 'graphRevision', 'graphChecksum', 'resultSeq', 'reason', 'evidenceDigests',
      'claimDigest', 'intentSeq', 'candidateChecksum', 'expectedGraphRevision', 'operation'])
        || typeof row.operationId !== 'string' || operations.has(row.operationId) || !hex(row.payloadHash)
        || !['COMMITTED', 'ABORTED'].includes(row.status) || !integer(row.graphRevision)
        || (row.graphChecksum !== null && !hex(row.graphChecksum)) || !integer(row.resultSeq)
        || (row.reason !== null && (typeof row.reason !== 'string' || row.reason.length > 1200))
        || !hex(row.claimDigest) || !hex(row.candidateChecksum) || !integer(row.intentSeq) || !integer(row.expectedGraphRevision)
        || !['create', 'begin', 'finish', 'skip', 'reconcile', 'revise'].includes(row.operation)
        || !Array.isArray(row.evidenceDigests) || row.evidenceDigests.length > 32 || row.evidenceDigests.some(x => !hex(x)))
      fail('JOURNAL_CLAIM_INVALID')
    operations.add(row.operationId)
    if ((value.document?.state.operations.includes(row.operationId) ?? false) !== (row.status === 'COMMITTED')) fail('JOURNAL_COMMIT_OPERATION_MISMATCH')
  }
  if (value.activeProof) {
    if (!fields(value.activeProof, ['attemptId', 'beginResultSeq', 'beginTurn', 'workStartedAtBegin', 'workExecutedAtBegin']) || !integer(value.activeProof.beginResultSeq)
        || !integer(value.activeProof.beginTurn) || !integer(value.activeProof.workStartedAtBegin) || !integer(value.activeProof.workExecutedAtBegin)
        || value.document?.state.active?.attemptId !== value.activeProof.attemptId)
      fail('JOURNAL_ACTIVE_PROOF_MISMATCH')
  } else if (value.document?.state.active) fail('JOURNAL_ACTIVE_PROOF_REQUIRED')
  const p = value.pending
  if (p) {
    if (!fields(p, ['operationId', 'payloadHash', 'operation', 'arguments', 'callId', 'rootCallId', 'turn', 'sessionId',
      'owner', 'bindingDigest', 'expectedGraphRevision', 'candidate', 'resolvedEvidence', 'intentSeq', 'claimDigest', 'clearedWork'])
        || operations.has(p.operationId) || !hex(p.payloadHash) || !hex(p.bindingDigest) || !hex(p.claimDigest)
        || claimDigest(p) !== p.claimDigest || p.bindingDigest !== digest(binding) || p.sessionId !== binding.sessionId
        || !['create', 'begin', 'finish', 'skip', 'reconcile', 'revise'].includes(p.operation) || !integer(p.turn)
        || p.expectedGraphRevision !== (value.document?.revision ?? 0) || (p.intentSeq !== null && !integer(p.intentSeq))
        || !Array.isArray(p.resolvedEvidence) || p.resolvedEvidence.length > 32 || !Array.isArray(p.clearedWork) || p.clearedWork.length > 1024
        || p.clearedWork.some(row => !fields(row, ['rootCallId', 'callSeq', 'rootResultSeq', 'eventDigest'])
          || typeof row.rootCallId !== 'string' || !row.rootCallId || row.rootCallId.length > 512 || !integer(row.callSeq)
          || row.rootResultSeq !== null && !integer(row.rootResultSeq) || !hex(row.eventDigest))) fail('JOURNAL_PENDING_INVALID')
    validateDocument(p.candidate)
    if (p.candidate.revision !== p.expectedGraphRevision + 1 || p.candidate.events.at(-1).operationId !== p.operationId
        || canonical(p.candidate.events.slice(0, -1)) !== canonical(value.document?.events ?? [])) fail('JOURNAL_CANDIDATE_NOT_SINGLE_APPEND')
  }
  return true
}

export class HostJournal {
  constructor({ projectRoot, directory, binding, store, readOnly = false }) {
    this.binding = copy(binding)
    const validate = value => validateJournal(value, this.binding)
    this.store = store ?? new FileGraphStore({ projectRoot, directory, fileName: 'transaction-host-journal.json', maximumBytes: 12 * 1024 * 1024, readOnly,
      validator: validate, updateValidator: (previous, next) => {
        if (next.revision !== (previous?.revision ?? 0) + 1 || previous && canonical(previous.binding) !== canonical(next.binding)) fail('JOURNAL_CAS_REVISION_OR_SCOPE')
        const oldClaims = previous?.claims ?? []
        if (canonical(next.claims.slice(0, oldClaims.length)) !== canonical(oldClaims)) fail('JOURNAL_CLAIM_HISTORY_IMMUTABLE')
      } })
  }
  read() {
    const value = this.store.read() ?? initialJournal(this.binding)
    validateJournal(value, this.binding)
    return value
  }
  change(expected, update) {
    return this.store.compareAndSwap(expected, previous => {
      const before = previous ?? initialJournal(this.binding)
      validateJournal(before, this.binding)
      const after = seal({ ...update(copy(before)), schema: 4, binding: copy(this.binding), revision: before.revision + 1 })
      validateJournal(after, this.binding)
      return after
    })
  }
  reserve(claim) {
    const before = this.read()
    return this.change(before.revision, state => {
      if (state.pending) fail('PENDING_INTENT_REQUIRES_RECONCILIATION')
      if (state.claims.some(row => row.operationId === claim.operationId)) fail('HOST_TOOL_CALL_REPLAY')
      if (state.claims.length >= MAX_CLAIMS) fail('HOST_CLAIM_LIMIT')
      return { ...state, pending: copy(claim) }
    })
  }
  bindIntent(operationId, intentSeq) {
    const before = this.read()
    return this.change(before.revision, state => {
      if (state.pending?.operationId !== operationId || state.pending.intentSeq !== null && state.pending.intentSeq !== intentSeq) fail('HOST_INTENT_CHANGED')
      return { ...state, pending: { ...state.pending, intentSeq } }
    })
  }
  resolve(projected, { rejectReason = null } = {}) {
    const before = this.read(), pending = before.pending
    if (!pending) return before
    if (projected.data.operationId !== pending.operationId || projected.data.claimDigest !== pending.claimDigest
        || projected.data.bindingDigest !== pending.bindingDigest || projected.intentSeq !== pending.intentSeq
        || projected.data.operation !== pending.operation || projected.data.expectedGraphRevision !== pending.expectedGraphRevision
        || projected.data.candidateChecksum !== pending.candidate.checksum || projected.data.callId !== pending.callId
        || projected.data.rootCallId !== pending.rootCallId || projected.data.turn !== pending.turn || projected.data.sessionId !== pending.sessionId
        || canonical(projected.data.clearedWork) !== canonical(pending.clearedWork))
      fail('HOST_PERSISTED_INTENT_PROOF_MISMATCH')
    if (!['SUCCESS', 'FAILED'].includes(projected.status) || !integer(projected.rootResultSeq)) fail('HOST_RESULT_UNKNOWN_NO_COMMIT')
    return this.change(before.revision, state => {
      if (canonical(state.pending) !== canonical(pending)) fail('HOST_PENDING_CHANGED')
      if (rejectReason !== null && (typeof rejectReason !== 'string' || !rejectReason || rejectReason.length > 1200)) fail('INVALID_CANDIDATE_REJECTION')
      const committed = projected.status === 'SUCCESS' && rejectReason === null, document = committed ? pending.candidate : state.document
      let activeProof = state.activeProof
      if (committed && pending.operation === 'begin') activeProof = { attemptId: document.state.active.attemptId,
        beginResultSeq: projected.rootResultSeq, beginTurn: pending.turn, workStartedAtBegin: projected.workStartedAtRoot,
        workExecutedAtBegin: projected.workExecutedAtRoot }
      if (committed && ['finish', 'reconcile'].includes(pending.operation)) activeProof = null
      const row = { operationId: pending.operationId, payloadHash: pending.payloadHash, status: committed ? 'COMMITTED' : 'ABORTED',
        graphRevision: document?.revision ?? 0, graphChecksum: document?.checksum ?? null, resultSeq: projected.rootResultSeq,
        reason: committed ? null : rejectReason ?? 'Root/ancestor execution or typed-result qualification failed; candidate not applied. Original tool/result unchanged.',
        claimDigest: pending.claimDigest, intentSeq: pending.intentSeq, candidateChecksum: pending.candidate.checksum,
        expectedGraphRevision: pending.expectedGraphRevision, operation: pending.operation,
        evidenceDigests: pending.resolvedEvidence.map(digest) }
      return { ...state, document, activeProof, pending: null, claims: [...state.claims, row] }
    })
  }
}
