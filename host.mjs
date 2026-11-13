// SPDX-License-Identifier: GPL-3.0-only
import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { TransactionGraph, canonical, copy, digest, evidenceRefs, GraphError, view } from './core.mjs'
import { MemoryGraphStore } from './store.mjs'
import { HostJournal, claimDigest } from './journal.mjs'
import { KEY, INTENT, RECEIPT, RECOVERY } from './projection.mjs'
import { administrative, incompleteDisposition, ownedExecutionChain, unresolvedWork, workKey } from './work-policy.mjs'

const fail = (code, detail = code) => { throw new GraphError(code, detail) }
// Preserve the standalone pre-extension default. Callers may opt into a policy.
export const ARTIFACT_MAX_BYTES = 16 * 1024 * 1024
const under = (root, target) => { const relative = path.relative(root, target); return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep) }
export function realProjectPath(root, requested, { directory = true } = {}) {
  if (typeof requested !== 'string' || !path.isAbsolute(requested)) fail('ABSOLUTE_PROJECT_PATH_REQUIRED')
  const value = path.resolve(requested)
  if (!under(root, value)) fail('PATH_OUTSIDE_OWN_PROJECT')
  let cursor = root
  for (const part of path.relative(root, value).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part)
    if (fs.lstatSync(cursor).isSymbolicLink()) fail('PROJECT_SYMLINK_REJECTED')
  }
  const info = fs.lstatSync(value)
  if (fs.realpathSync(value) !== value || (directory ? !info.isDirectory() : !info.isFile())) fail('PROJECT_PATH_TYPE_OR_IDENTITY')
  return value
}
export const sessionReference = (sessionId, seq) => `dsh-session:${encodeURIComponent(sessionId)}#event=${seq}`
// Official JSONL toHeaderLine uses delegationDepth ?? 0; a freshly created
// Session may omit this one optional field. Every other header field remains
// part of exact equality; this is not a general projection or subset compare.
export function sameStoredSessionHeader(a, b) {
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) || Array.isArray(b)) return false
  return canonical({ ...a, delegationDepth: a.delegationDepth ?? 0 }) === canonical({ ...b, delegationDepth: b.delegationDepth ?? 0 })
}
function referenceSeq(reference, sessionId) {
  const prefix = `dsh-session:${encodeURIComponent(sessionId)}#event=`
  if (!reference.startsWith(prefix) || !/^\d+$/.test(reference.slice(prefix.length))) fail('EVIDENCE_OTHER_SESSION_OR_FORMAT')
  const value = Number(reference.slice(prefix.length))
  if (!Number.isSafeInteger(value) || value < 0) fail('EVIDENCE_BAD_SEQ')
  return value
}
export function artifactProof(projectRoot, ref, signal, { maxBytes = ARTIFACT_MAX_BYTES } = {}) {
  if (!ref.sha256) fail('ARTIFACT_SHA_REQUIRED')
  const identity = readArtifactIdentity(projectRoot, ref, signal, { maxBytes })
  if (identity.sha256 !== ref.sha256) fail('ARTIFACT_CHANGED_OR_HASH_MISMATCH')
  return identity
}
/** Observation of a historically verified deliverable, never current acceptance. */
export function artifactCurrentIdentity(projectRoot, ref, signal, options) {
  if (!ref.sha256) fail('ARTIFACT_SHA_REQUIRED')
  try {
    const identity = readArtifactIdentity(projectRoot, ref, signal, options)
    return { ref: identity.path, acceptedSha256: ref.sha256, currentSha256: identity.sha256,
      status: identity.sha256 === ref.sha256 ? 'UNCHANGED' : 'CHANGED', stat: identity.stat }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    return { ref: ref.ref, acceptedSha256: ref.sha256, currentSha256: null, status: 'MISSING' }
  }
}
function readArtifactIdentity(projectRoot, ref, signal, { maxBytes = ARTIFACT_MAX_BYTES } = {}) {
  if (maxBytes !== null && (!Number.isSafeInteger(maxBytes) || maxBytes < 1)) fail('ARTIFACT_BYTE_POLICY_INVALID')
  const requested = path.isAbsolute(ref.ref) ? ref.ref : path.resolve(projectRoot, ref.ref)
  const file = realProjectPath(projectRoot, requested, { directory: false })
  if (file.toLowerCase().endsWith('.gguf')) fail('MODEL_CONTENT_IS_NOT_TRANSACTION_ARTIFACT')
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  try {
    const before = fs.fstatSync(fd, { bigint: true })
    if (!before.isFile() || maxBytes !== null && before.size > BigInt(maxBytes)) fail('ARTIFACT_BYTE_LIMIT')
    const hash = createHash('sha256'), buffer = Buffer.alloc(65536)
    let total = 0n
    while (true) {
      signal?.throwIfAborted()
      const bytes = fs.readSync(fd, buffer, 0, buffer.length, null)
      if (!bytes) break
      total += BigInt(bytes); if (total > before.size) fail('ARTIFACT_GREW_DURING_READ')
      hash.update(buffer.subarray(0, bytes))
    }
    const after = fs.fstatSync(fd, { bigint: true }), outside = fs.lstatSync(file, { bigint: true })
    const keys = ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs']
    if (total !== before.size || keys.some(key => before[key] !== after[key] || before[key] !== outside[key])
        || fs.realpathSync(file) !== file) fail('ARTIFACT_CHANGED_OR_HASH_MISMATCH')
    return { kind: 'artifact', refDigest: digest(ref), path: file, sha256: hash.digest('hex'),
      stat: Object.fromEntries(keys.map(key => [key, String(before[key])])) }
  } finally { fs.closeSync(fd) }
}

export function resolveEvidence({ references, state, binding, activeProof, outcome, signal }) {
  const refs = evidenceRefs(references), result = []
  let successfulAfterBegin = 0
  for (const ref of refs) {
    if (ref.kind === 'artifact') { result.push(artifactProof(binding.projectRoot, ref, signal)); continue }
    const seq = referenceSeq(ref.ref, binding.sessionId)
    const proof = state.proofs.find(row => row.seq === seq)
    if (seq < state.ownFrom || !proof || proof.rootResultSeq >= state.lastSeq + 1) fail('EVIDENCE_NOT_OWN_COMMITTED_TOOL_RESULT')
    if (ref.sha256 && ref.sha256 !== proof.eventDigest) fail('EVIDENCE_EVENT_DIGEST_MISMATCH')
    if (activeProof && (seq <= activeProof.beginResultSeq || proof.rootCallSeq <= activeProof.beginResultSeq || proof.rootResultSeq <= activeProof.beginResultSeq))
      fail('ACTIVE_EVIDENCE_MUST_FOLLOW_BEGIN_COMMIT')
    if (outcome === 'complete') {
      if (!activeProof) fail('ACTIVE_BEGIN_PROOF_REQUIRED')
      if (!proof.successful || proof.qualification !== 'SUCCESS' || proof.ownOutcome !== 'UNVERIFIED') fail('FAILED_UNKNOWN_OR_NOT_RUN_CANNOT_COMPLETE')
      successfulAfterBegin++
    }
    result.push({ kind: ref.kind, refDigest: digest(ref), ...copy(proof) })
  }
  if (outcome === 'complete' && successfulAfterBegin < 1) fail('COMPLETE_REQUIRES_ACTUAL_SUCCESSFUL_TOOL_EVIDENCE')
  return result
}

export class DshTransactionHost {
  constructor(ctx, { projectRoot, storageRelative = '.dsh/transaction-graphs-v4', enableSwitch = false,
    appendPluginRecord, journalFactory = options => new HostJournal(options), owner = `owner_${randomUUID()}` }) {
    if (typeof appendPluginRecord !== 'function') fail('SESSION_WRITER_REQUIRED')
    if (projectRoot !== undefined && (typeof projectRoot !== 'string' || !path.isAbsolute(projectRoot)
        || fs.realpathSync(projectRoot) !== path.resolve(projectRoot) || !fs.lstatSync(projectRoot).isDirectory()))
      fail('EXPLICIT_REAL_PROJECT_REQUIRED')
    if (!ctx.sessionPersistence || typeof ctx.sessionPersistence.open !== 'function') fail('REAL_SESSION_PERSISTENCE_REQUIRED')
    if (typeof storageRelative !== 'string' || path.isAbsolute(storageRelative) || !storageRelative || storageRelative.split(/[\\/]/).some(x => !x || x === '..' || x === '.')) fail('INVALID_STORAGE_RELATIVE_PATH')
    if (typeof enableSwitch !== 'boolean') fail('INVALID_SWITCH_POLICY')
    this.ctx = ctx; this.projectRoot = projectRoot === undefined ? undefined : path.resolve(projectRoot)
    this.storageRelative = storageRelative; this.enableSwitch = enableSwitch
    this.append = appendPluginRecord; this.journalFactory = journalFactory; this.owner = owner
    this.journals = new Map(); this.serial = new WeakMap(); this.tasks = new Set(); this.definitions = new Map(); this.closed = false
    this.recoveryVerifier = null
    this.running = new WeakMap()
    this.lifecycle = new AbortController()
  }
  projection(session) {
    const state = this.ctx.sessionProjections.stateOf(session, KEY)
    if (!state || state.failure) fail('TRANSACTION_PROJECTION_UNAVAILABLE', state?.failure ?? 'Required projection missing')
    return state
  }
  binding(session) {
    if (this.ctx.sessions.get(session.id) !== session || session.header.id !== session.id || !Number.isSafeInteger(session.header.createdAt)) fail('SESSION_NOT_EXACT_LIVE_OWNER')
    const original = realProjectPath(this.projectRoot ?? session.header.cwd, session.header.cwd)
    const projectRoot = this.projectRoot ?? original
    realProjectPath(projectRoot, this.ctx.workingDirectory.get(session))
    return { contract: 'DSH_TRANSACTION_GRAPH_HOST_V4', projectRoot, sessionId: session.id,
      sessionCreatedAt: session.header.createdAt, originalCwd: original, enableSwitch: this.enableSwitch }
  }
  journal(session, { readOnly = false } = {}) {
    const binding = this.binding(session), key = digest(binding)
    const cached = this.journals.get(key)
    const journal = cached ?? this.journalFactory({ projectRoot: binding.projectRoot,
      directory: path.join(binding.projectRoot, this.storageRelative, key), binding, readOnly })
    if (!cached && !readOnly) this.journals.set(key, journal)
    const saved = journal.read(), projected = this.projection(session)
    if (saved.revision === 0 && (projected.intents.length || projected.receipts.length)) fail('HOST_JOURNAL_MISSING_FOR_RECORDED_SESSION')
    for (const row of saved.claims) {
      const intent = projected.intents.find(item => item.data.operationId === row.operationId)
      if (!intent || intent.intentSeq !== row.intentSeq || intent.rootResultSeq !== row.resultSeq
          || intent.data.claimDigest !== row.claimDigest || intent.data.candidateChecksum !== row.candidateChecksum
          || intent.data.expectedGraphRevision !== row.expectedGraphRevision || intent.data.operation !== row.operation
          || row.status === 'COMMITTED' && intent.status !== 'SUCCESS') fail('JOURNAL_NOT_ANCHORED_TO_ACTUAL_SESSION_INTENT')
      const receipt = projected.receipts.find(item => item.operationId === row.operationId)
      if (receipt && ['status', 'graphRevision', 'graphChecksum'].some(field => receipt[field] !== row[field])) fail('JOURNAL_SESSION_RECEIPT_CONFLICT')
    }
    const latestCommit = saved.claims.findLast(row => row.status === 'COMMITTED')
    if ((saved.document !== null) !== Boolean(latestCommit) || latestCommit &&
        (latestCommit.graphRevision !== saved.document.revision || latestCommit.graphChecksum !== saved.document.checksum
          || latestCommit.candidateChecksum !== saved.document.checksum)) fail('GRAPH_NOT_ANCHORED_TO_COMMITTED_CANDIDATE')
    if (saved.activeProof) {
      const begin = projected.intents.find(row => row.data.operationId === latestCommit?.operationId)
      const proof = saved.activeProof
      if (begin?.data.operation !== 'begin' || begin.rootResultSeq !== proof.beginResultSeq || begin.data.turn !== proof.beginTurn
          || begin.workStartedAtRoot !== proof.workStartedAtBegin || begin.workExecutedAtRoot !== proof.workExecutedAtBegin)
        fail('ACTIVE_BEGIN_WORK_BASELINE_MISMATCH')
    }
    return { journal, binding, key, saved }
  }
  inProject(session) {
    if (this.closed || !session) return false
    try { this.binding(session); return true } catch { return false }
  }
  snapshot(session) {
    const base = { sessionId: session.id, graph: null }
    try {
      if (this.closed) fail('HOST_DISPOSED')
      const binding = this.binding(session), key = digest(binding), projected = this.projection(session)
      const file = path.join(binding.projectRoot, this.storageRelative, key, 'transaction-host-journal.json')
      if (!fs.existsSync(file)) {
        if (projected.intents.length || projected.receipts.length) fail('HOST_JOURNAL_MISSING_FOR_RECORDED_SESSION')
        return { ...base, status: 'empty' }
      }
      const { saved } = this.journal(session, { readOnly: true })
      if (!saved.document) return { ...base, status: 'empty' }
      const display = view(saved.document, this.owner), plan = saved.document.state.plan
      const parents = new Map(plan.nodes.map(node => [node.id, node.parent]))
      const blocked = new Set(display.pendingButBlocked.filter(node => node.unmetPrerequisites.length).map(node => node.id))
      const pending = saved.pending ? { operation: saved.pending.operation,
        qualification: projected.intents.find(row => row.data.operationId === saved.pending.operationId)?.status ?? 'UNKNOWN' } : null
      const choices = rows => pending ? [] : rows.map(({ id, choice }) => ({ id, choice }))
      return { ...base, status: 'ready', graph: { revision: display.revision, title: display.graph.title,
        nodes: display.nodes.map(({ id, label, kind, status, disposition, branchState, selectedBranch }) => ({
          id, label, kind, status, parent: parents.get(id), ...(disposition === undefined ? {} : { disposition }),
          ...(blocked.has(id) ? { blocked: true } : {}),
          ...(branchState ? { branchState } : {}), ...(selectedBranch ? { selectedBranch } : {}),
        })),
        edges: plan.edges.map(({ from, to, kind, outcome, case: selectedCase }) => ({ from, to, kind,
          ...(outcome === undefined ? {} : { outcome }), ...(selectedCase === undefined ? {} : { case: selectedCase }) })),
        active: display.active ? { nodeId: display.active.nodeId, recoveryRequired: display.active.recoveryRequired } : null,
        pending, legalNext: choices(display.legalNext), skipChoices: choices(display.skipChoices) } }
    } catch { return { ...base, status: 'unavailable' } }
  }
  presence(session) {
    if (!this.inProject(session)) return { state: 'OUTSIDE_SCOPE', previouslyCommitted: false }
    const projected = this.projection(session)
    const previouslyCommitted = projected.receipts.some(row => row.status === 'COMMITTED')
    try {
      const binding = this.binding(session)
      const file = path.join(binding.projectRoot, this.storageRelative, digest(binding), 'transaction-host-journal.json')
      if (!fs.existsSync(file)) {
        if (projected.intents.length || projected.receipts.length) fail('HOST_JOURNAL_MISSING_FOR_RECORDED_SESSION')
        return { state: 'NEVER_CREATED', previouslyCommitted: false, revision: 0 }
      }
      const { saved } = this.journal(session, { readOnly: true })
      return { state: saved.document ? 'PRESENT' : previouslyCommitted ? 'LOST_OR_INVALID_AFTER_COMMIT' : saved.pending ? 'CREATION_PENDING' : 'NEVER_CREATED', previouslyCommitted,
        revision: saved.document?.revision ?? 0 }
    } catch (error) {
      return { state: previouslyCommitted ? 'LOST_OR_INVALID_AFTER_COMMIT' : 'UNKNOWN_INTERRUPTED_CREATION',
        previouslyCommitted, code: error.code ?? error.name }
    }
  }
  assertOwned(authority, exec) {
    const agent = exec.agent
    exec.signal?.throwIfAborted()
    if (this.closed || !agent || agent !== authority.agent || agent.session !== authority.session || agent.status !== 'running'
        || this.ctx.agents.get(agent.id) !== agent || this.ctx.agents.currentInitiator() !== agent
        || this.ctx.sessions.get(agent.session.id) !== agent.session || digest(this.binding(agent.session)) !== authority.sessionScope)
      fail('EXECUTION_OWNER_CHANGED')
    const definition = this.definitions.get(exec.name)
    if (!definition || this.ctx.tools.get(exec.name, agent) !== definition) fail('EXACT_REGISTERED_TRANSACTION_TOOL_REQUIRED')
    if (!this.projection(agent.session).turn) fail('OPEN_MODEL_TURN_REQUIRED')
  }
  async authorize(exec) {
    if (this.allowClassic && !this.allowClassic(exec.agent)) fail('TRANSACTION_GRAPH_SESSION_EXTENSION_DENIED')
    if (!exec.agent || this.ctx.agents.get(exec.agent.id) !== exec.agent || this.ctx.agents.currentInitiator() !== exec.agent) fail('EXACT_CALLING_AGENT_REQUIRED')
    await this.ctx.workingDirectory.ensure(exec.agent, exec.signal)
    const { binding, key } = this.journal(exec.agent.session)
    const authority = { agent: exec.agent, session: exec.agent.session, agentId: exec.agent.id,
      sessionScope: key, currentInitiatorVerified: true, binding }
    this.assertOwned(authority, exec)
    return authority
  }
  schedule(session) {
    const previous = this.serial.get(session) ?? Promise.resolve()
    const task = previous.catch(() => {}).then(() => this.drain(session))
    this.serial.set(session, task)
    this.track(task)
    // Session publication contains listener exceptions; retain failure as pending
    // rather than claiming a successful commit. A subsequent read retries safely.
    task.catch(error => this.ctx.logger?.warn(`transaction graph pending reconciliation: ${error.message}`))
    return task
  }
  track(task) {
    this.tasks.add(task); task.then(() => this.tasks.delete(task), () => this.tasks.delete(task))
    return task
  }
  finishChain(exec, state) {
    const chain = ownedExecutionChain(exec, this.running.get(exec.agent) ?? [])
    const root = [...this.running.get(exec.agent) ?? []].find(row => row.callId === exec.rootCallId && chain.ancestors.has(row.token))
    if (!root || state.calls[root.callId]?.tool !== root.name) fail('OWNED_ROOT_DOES_NOT_MATCH_SESSION_CALL')
    if (chain.others.length) fail('FINISH_OTHER_OWN_TOOLS_BEFORE_TRANSACTION_FINISH')
    return chain
  }
  workState(session, saved, state = this.projection(session)) {
    const agent = this.ctx.agents.get(session.id), rows = [...this.running.get(agent) ?? []]
    const ignored = new Set(), callIds = new Set()
    const protocol = rows.filter(item => administrative(item.name)
      && this.definitions.has(item.name) && this.ctx.tools.get(item.name, item.agent) === this.definitions.get(item.name))
    // The one read/mutation waiting on this drain and its real ancestors are
    // protocol transport. Never union two sibling chains into a fake quiescence.
    const chains = protocol.map(row => ownedExecutionChain(row, rows))
    const maximal = chains.filter(chain => protocol.every(row => chain.ancestors.has(row.token)))
    if (maximal.length === 1) {
      const chain = maximal[0]
      for (const token of chain.ancestors) ignored.add(token)
      for (const id of chain.callIds) callIds.add(id)
    }
    return { unresolved: unresolvedWork(state, saved.activeProof, callIds), running: rows.filter(row => !ignored.has(row.token)),
      workStarted: state.workStarted, workExecuted: state.workExecuted }
  }
  async flush(session, proofs) {
    const backend = this.ctx.sessionPersistence, identity = backend.identity
    if (!Array.isArray(proofs) || !proofs.length) fail('EXACT_DURABILITY_EVENT_PROOFS_REQUIRED')
    if (await this.ctx.sessions.flush(session) !== true) fail('DURABLE_SESSION_FLUSH_LISTENER_REQUIRED')
    if (this.ctx.sessions.get(session.id) !== session) fail('SESSION_DISPOSED_DURING_FLUSH')
    // A no-op flush listener must not stand in for the real storage writer.
    const handle = await backend.open(session.id, 'read')
    try {
      if (handle.access !== 'read' || handle.id !== session.id || !sameStoredSessionHeader(handle.header, session.header)
          || handle.inheritedEventCount !== session.inheritedEventCount) fail('DURABLE_SESSION_HEADER_OR_SCOPE_MISMATCH')
      for (const proof of proofs) {
        const result = await handle.read(proof.seq, 1)
        if (result.events.length !== 1 || result.events[0].seq !== proof.seq || digest(result.events[0]) !== proof.digest)
          fail('DURABLE_SESSION_EVENT_PROOF_REQUIRED')
      }
      if (this.ctx.sessionPersistence.identity !== identity || this.ctx.sessions.get(session.id) !== session) fail('PERSISTENCE_OWNER_CHANGED_DURING_PROOF')
    } finally { await handle.close() }
  }
  async drain(session) {
    if (this.closed) return
    const { journal, binding } = this.journal(session)
    let saved = journal.read(), projected = this.projection(session)
    if (saved.pending) {
      const p = saved.pending, record = projected.intents.find(row => row.data.operationId === p.operationId)
      if (!record || !['SUCCESS', 'FAILED'].includes(record.status)) return saved
      if (record.data.claimDigest !== p.claimDigest || record.data.bindingDigest !== digest(binding)) fail('PENDING_SESSION_PROOF_CHANGED')
      // Root result + all PTC ancestors must survive the session durability barrier
      // before the separate atomic journal can commit a candidate.
      await this.flush(session, [{ seq: record.intentSeq, digest: record.intentDigest },
        { seq: record.rootResultSeq, digest: record.rootResultDigest }])
      if (this.closed) fail('HOST_DISPOSED_NO_COMMIT')
      projected = this.projection(session)
      const current = projected.intents.find(row => row.data.operationId === p.operationId)
      if (canonical(current) !== canonical(record)) fail('PENDING_RESULT_CHANGED_DURING_FLUSH')
      if (p.intentSeq === null) saved = journal.bindIntent(p.operationId, record.intentSeq)
      let rejectReason = null
      if (p.operation === 'revise') rejectReason = 'This retired host revision entry requires its original extension; it cannot commit in standalone mode.'
      if (p.operation === 'finish' && record.status === 'SUCCESS') {
        try {
          const work = this.workState(session, saved, projected)
          if (work.unresolved.length || work.running.length) fail('ACTIVE_OWNED_WORK_UNRESOLVED')
          const again = resolveEvidence({ references: p.arguments.evidence ?? [], state: projected, binding,
            activeProof: saved.activeProof, outcome: p.arguments.outcome })
          if (canonical(again) !== canonical(p.resolvedEvidence)) fail('FINISH_EVIDENCE_CHANGED_BEFORE_COMMIT')
          if (p.arguments.outcome === 'incomplete') incompleteDisposition({ requested: p.arguments.disposition,
            state: projected, activeProof: saved.activeProof, evidence: again })
        } catch (error) {
          // Reject this candidate while preserving the real successful root
          // result and ACTIVE transaction; this is not transport UNKNOWN.
          rejectReason = `Candidate evidence failed revalidation: ${error.code ?? 'ARTIFACT_OR_TOOL_REFERENCE_ERROR'}`
        }
      }
      if (p.operation === 'reconcile' && record.status === 'SUCCESS') {
        const work = this.workState(session, saved, projected)
        if (work.unresolved.length || work.running.length) rejectReason = 'New unresolved/running owned work appeared after operator cleanup approval; ACTIVE retained.'
      }
      saved = journal.resolve(current, { rejectReason })
    }
    for (const row of saved.claims) {
      if (this.closed) fail('HOST_DISPOSED_NO_RECEIPT_APPEND')
      if (projected.receipts.some(receipt => receipt.operationId === row.operationId)) continue
      const seq = this.append(session, RECEIPT, { operationId: row.operationId, status: row.status,
        graphRevision: row.graphRevision, graphChecksum: row.graphChecksum })
      const receipt = this.projection(session).receipts.find(value => value.seq === seq)
      if (!receipt) fail('RECEIPT_NOT_IN_ACTUAL_PROJECTION')
      await this.flush(session, [{ seq, digest: receipt.eventDigest }])
      projected = this.projection(session)
    }
    return saved
  }
  async read(authority, exec) {
    let reconciliationError = null
    try { await this.schedule(authority.session) } catch (error) { reconciliationError = error.code ?? 'JOURNAL_RECONCILIATION_FAILED' }
    this.assertOwned(authority, exec)
    const { journal } = this.journal(authority.session), saved = journal.read(), state = this.projection(authority.session)
    const result = view(saved.document, this.owner)
    const work = this.workState(authority.session, saved, state)
    return { ...result, ...(saved.pending ? { legalNext: [], skipChoices: [] } : {}),
      journalReconciliationError: reconciliationError,
      lastToolClaim: saved.claims.length ? copy(saved.claims.at(-1)) : null,
      unresolvedOwnedWork: work.unresolved, otherRunningWorkCount: work.running.length,
      pendingIntent: saved.pending ? { operationId: saved.pending.operationId, operation: saved.pending.operation,
        state: reconciliationError ? 'COMMIT_BLOCKED' : 'AWAITING_ACTUAL_ROOT_RESULT_OR_JOURNAL_COMMIT',
        rootAndParentQualification: state.intents.find(row => row.data.operationId === saved.pending.operationId)?.status ?? 'UNKNOWN',
        qualificationMeaning: 'Execution/typed-result ancestry qualification; original root tool/result is unchanged.',
        reconciliationError,
        instruction: 'Do not replay this call or begin dependent work. Reconcile the actual root tool result.' } : null,
      recentToolEvidence: state.proofs.slice(-32).map(row => ({ ref: sessionReference(authority.session.id, row.seq),
        kind: 'tool_result', sha256: row.eventDigest, tool: row.tool, successful: row.successful,
        ownOutcome: row.ownOutcome, isError: row.isError, qualification: row.qualification,
        ancestorOutcomes: row.ancestorOutcomes, afterActiveBegin: Boolean(saved.activeProof && row.seq > saved.activeProof.beginResultSeq) })),
      qualification: 'Successful owned tool execution references only; semantic acceptance and GoalReview remain independent.' }
  }
  stageMutation(request) { return this.track(this.stage(request)) }
  async stage({ operation, arguments: args, operationId, authority, execution: exec }) {
    await this.schedule(authority.session)
    this.assertOwned(authority, exec)
    const { journal, binding } = this.journal(authority.session), saved = journal.read(), state = this.projection(authority.session)
    if (saved.pending) fail('PENDING_INTENT_REQUIRES_RECONCILIATION')
    if (operation === 'finish') {
      const chain = this.finishChain(exec, state)
      if (unresolvedWork(state, saved.activeProof, chain.callIds).length) fail('ACTIVE_OWNED_WORK_UNRESOLVED')
    }
    if (saved.document?.state.active?.owner && saved.document.state.active.owner !== this.owner) fail('ACTIVE_RESTART_REQUIRES_EXPLICIT_OPERATOR_RECONCILIATION')
    const payloadHash = digest({ operation, arguments: args })
    if (saved.claims.some(row => row.operationId === operationId)) fail('HOST_TOOL_CALL_REPLAY')
    const resolvedEvidence = operation === 'finish' || operation === 'skip'
      ? resolveEvidence({ references: args.evidence ?? [], state, binding, activeProof: saved.activeProof,
        outcome: operation === 'finish' ? args.outcome : 'incomplete', signal: exec.signal }) : []
    if (operation === 'finish' && args.outcome === 'incomplete') incompleteDisposition({ requested: args.disposition,
      state, activeProof: saved.activeProof, evidence: resolvedEvidence })
    if (operation === 'finish' && args.outcome === 'complete' && args.disposition !== undefined) fail('COMPLETE_HAS_NO_INCOMPLETE_DISPOSITION')
    const temporary = new MemoryGraphStore(saved.document), core = new TransactionGraph(temporary, {
      enableSwitch: this.enableSwitch, id: prefix => prefix === 'owner' ? this.owner : `${prefix}_${randomUUID()}` })
    if (!['create', 'begin', 'finish', 'skip'].includes(operation)) fail('UNKNOWN_TRANSACTION_OPERATION')
    core[operation]({ ...copy(args), operationId })
    const candidate = temporary.read(), claim = { operationId, payloadHash, operation, arguments: copy(args),
      callId: exec.callId, rootCallId: exec.rootCallId ?? exec.callId, turn: state.turn, sessionId: binding.sessionId,
      owner: this.owner, bindingDigest: digest(binding), expectedGraphRevision: saved.document?.revision ?? 0,
      candidate, resolvedEvidence, clearedWork: [], intentSeq: null }
    claim.claimDigest = claimDigest(claim)
    this.assertOwned(authority, exec)
    journal.reserve(claim)
    const intentSeq = this.append(authority.session, INTENT, { version: 4, operationId, callId: claim.callId,
      rootCallId: claim.rootCallId, turn: claim.turn, sessionId: claim.sessionId,
      bindingDigest: claim.bindingDigest, claimDigest: claim.claimDigest, operation,
      expectedGraphRevision: claim.expectedGraphRevision, candidateChecksum: candidate.checksum, clearedWork: [] })
    const projectedIntent = this.projection(authority.session).intents.find(row => row.intentSeq === intentSeq)
    if (!projectedIntent) fail('INTENT_NOT_IN_ACTUAL_PROJECTION')
    await this.flush(authority.session, [{ seq: intentSeq, digest: projectedIntent.intentDigest }])
    this.assertOwned(authority, exec)
    journal.bindIntent(operationId, intentSeq)
    this.assertOwned(authority, exec)
    return { state: 'PENDING_HOST_COMMIT', operationId, intentSequence: intentSeq,
      candidateGraphRevision: candidate.revision, commit: 'Await actual successful root tool result and all PTC parents, then read.' }
  }
  registerRecoveryVerifier({ verify, version }) {
    if (this.recoveryVerifier || typeof verify !== 'function' || typeof version !== 'string' || !version) fail('EXPLICIT_SINGLE_TRUSTED_RECOVERY_VERIFIER_REQUIRED')
    const row = { verify, hash: digest({ version, source: verify.toString() }) }
    this.recoveryVerifier = row
    return () => { if (this.recoveryVerifier === row) this.recoveryVerifier = null }
  }
  context(agent) {
    if (!agent || this.ctx.agents.get(agent.id) !== agent) return ''
    try {
      const binding = this.binding(agent.session), key = digest(binding)
      const file = path.join(binding.projectRoot, this.storageRelative, key, 'transaction-host-journal.json')
      if (!this.journals.has(key) && !fs.existsSync(file)) {
        if (this.projection(agent.session).intents.length) fail('HOST_JOURNAL_MISSING_FOR_RECORDED_SESSION')
        return '<transaction_graph_state>{"graph":null,"instruction":"Use transaction_graph_read before creating a graph."}</transaction_graph_state>'
      }
      const saved = this.journal(agent.session).journal.read(), state = view(saved.document, this.owner)
      const work = this.workState(agent.session, saved)
      const value = { revision: state.revision, graph: state.graph ? { id: state.graph.id, title: state.graph.title.slice(0, 120) } : null,
        active: state.active ? { nodeId: state.active.nodeId, recoveryRequired: state.active.recoveryRequired } : null,
        pendingIntent: saved.pending ? { operationId: saved.pending.operationId, operation: saved.pending.operation } : null,
        legalNextCount: saved.pending ? 0 : state.legalNext.length,
        legalNext: saved.pending ? [] : state.legalNext.slice(0, 8).map(row => ({ choice: row.choice, id: row.id, label: row.label.slice(0, 80) })),
        lastClaim: saved.claims.length ? { status: saved.claims.at(-1).status, graphRevision: saved.claims.at(-1).graphRevision } : null,
        unresolvedOwnedWorkCount: work.unresolved.length, otherRunningWorkCount: work.running.length,
        goalReached: false, instruction: 'Read full program choices/evidence before mutation. Pending/ACTIVE restart requires reconciliation; do not replay.' }
      const result = JSON.stringify(value)
      if (Buffer.byteLength(result) > 4096) fail('CONTEXT_PROGRAM_VIEW_LIMIT')
      return `<transaction_graph_state>\n${result}\n</transaction_graph_state>`
    } catch (error) { return `<transaction_graph_state>${JSON.stringify({ state: 'BLOCKED', reason: error.code ?? 'TRANSACTION_GRAPH_READ_FAILED', goalReached: false })}</transaction_graph_state>` }
  }
  // Trusted Host API only, deliberately absent from the model's five tools.
  // It can abandon an interrupted attempt as INCOMPLETE, never certify success.
  recoverInterrupted(agent, request) { return this.track(this.recover(agent, request)) }
  async recover(agent, { expectedRevision, expectedAttemptId, note }) {
    const verifier = this.recoveryVerifier
    if (!verifier || this.closed || this.ctx.agents.get(agent.id) !== agent || this.ctx.sessions.get(agent.session.id) !== agent.session)
      fail('TRUSTED_OPERATOR_RECOVERY_REQUIRED')
    const session = agent.session
    await this.schedule(session)
    if (this.closed) fail('HOST_DISPOSED_NO_RECOVERY')
    const { journal, binding } = this.journal(session), before = journal.read()
    if (before.pending || !before.document?.state.active || before.document.revision !== expectedRevision
        || before.document.state.active.attemptId !== expectedAttemptId)
      fail('RECOVERY_STATE_PENDING_STALE_OR_NOT_INTERRUPTED')
    const initialWork = this.workState(session, before)
    if (before.document.state.active.owner === this.owner && !initialWork.unresolved.length) fail('USE_NORMAL_INCOMPLETE_FOR_KNOWN_QUIESCENT_WORK')
    if (typeof note !== 'string' || !note.trim() || note.length > 1200) fail('RECOVERY_NOTE_REQUIRED')
    const accepted = await verifier.verify({ agent, session, binding: copy(binding), active: copy(before.document.state.active),
      expectedRevision, outcome: 'incomplete', disposition: 'UNSATISFIED', unresolvedOwnedWork: copy(initialWork.unresolved),
      runningWorkCount: initialWork.running.length, note, signal: this.lifecycle.signal })
    if (accepted !== true || this.closed || this.recoveryVerifier !== verifier || this.ctx.agents.get(agent.id) !== agent
        || this.ctx.sessions.get(session.id) !== session || canonical(journal.read()) !== canonical(before)) fail('RECOVERY_APPROVAL_NOT_CURRENT')
    const approved = this.workState(session, before), initialKeys = new Set(initialWork.unresolved.map(workKey))
    if (approved.running.length || approved.unresolved.some(row => !initialKeys.has(workKey(row)))) fail('OPERATOR_CLEANUP_DID_NOT_QUIESCE_OR_NEW_WORK_APPEARED')
    const clearedWork = approved.unresolved.map(({ state, ...raw }) => raw)
    const operationId = `op_${digest({ binding, attempt: expectedAttemptId, nonce: randomUUID() })}`
    const arguments_ = { expectedRevision, outcome: 'incomplete', disposition: 'UNSATISFIED', evidence: [], note }
    const recoveryOwner = `owner_reconcile_${randomUUID()}`
    const temporary = new MemoryGraphStore(before.document), core = new TransactionGraph(temporary, {
      enableSwitch: this.enableSwitch, id: prefix => prefix === 'owner' ? recoveryOwner : `${prefix}_${randomUUID()}`, verifyRecovery: async () => true })
    await core.reconcile({ ...arguments_, operationId })
    if (this.closed || this.recoveryVerifier !== verifier || canonical(journal.read()) !== canonical(before)) fail('RECOVERY_APPROVAL_NOT_CURRENT')
    const currentWork = this.workState(session, before)
    if (canonical(currentWork.unresolved) !== canonical(approved.unresolved) || currentWork.running.length
        || currentWork.workStarted !== approved.workStarted || currentWork.workExecuted !== approved.workExecuted) fail('RECOVERY_WORK_CHANGED_AFTER_APPROVAL')
    const callId = `operator_${randomUUID()}`, state = this.projection(session)
    const claim = { operationId, payloadHash: digest({ operation: 'reconcile', arguments: arguments_ }), operation: 'reconcile',
      arguments: arguments_, callId, rootCallId: callId, turn: state.turn, sessionId: binding.sessionId, owner: this.owner,
      bindingDigest: digest(binding), expectedGraphRevision: expectedRevision, candidate: temporary.read(),
      resolvedEvidence: [{ kind: 'operator_attestation', verifierHash: verifier.hash, expectedAttemptId, noteDigest: digest(note), clearedWork }],
      clearedWork, intentSeq: null }
    claim.claimDigest = claimDigest(claim)
    journal.reserve(claim)
    const intentSeq = this.append(session, RECOVERY, { version: 4, operationId, callId, rootCallId: callId,
      turn: state.turn, sessionId: binding.sessionId, bindingDigest: claim.bindingDigest, claimDigest: claim.claimDigest,
      operation: 'reconcile', expectedGraphRevision: claim.expectedGraphRevision, candidateChecksum: claim.candidate.checksum, clearedWork })
    const projectedIntent = this.projection(session).intents.find(row => row.intentSeq === intentSeq)
    if (!projectedIntent) fail('RECOVERY_NOT_IN_ACTUAL_PROJECTION')
    await this.flush(session, [{ seq: intentSeq, digest: projectedIntent.intentDigest }])
    if (this.closed) fail('HOST_DISPOSED_NO_RECOVERY_COMMIT')
    journal.bindIntent(operationId, intentSeq)
    await this.schedule(session)
    const after = journal.read()
    if (after.pending) fail('OPERATOR_RECOVERY_PENDING_NO_REPLAY')
    if (after.claims.at(-1)?.operationId !== operationId || after.claims.at(-1).status !== 'COMMITTED') fail('OPERATOR_RECOVERY_NOT_COMMITTED_ACTIVE_RETAINED')
    return view(after.document, this.owner)
  }
  async close() {
    this.closed = true
    this.lifecycle.abort(new Error('Transaction graph plugin disposed'))
    // No ACTIVE transaction, pending intent, old lock or user process is cleared.
    // Teardown never replays begin/finish or turns UNKNOWN into an abort/success.
    await Promise.allSettled([...this.tasks])
  }
}
