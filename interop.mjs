// SPDX-License-Identifier: GPL-3.0-only
import fs from 'node:fs'
import path from 'node:path'
import { copy, GraphError, validateDocument } from './core.mjs'

export const WORKFLOW_CONTRACT = 'dsh-taskgraph-workflow-v1'
const name = value => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,79}$/.test(value)
const fail = code => { throw new GraphError(code) }
const within = (root, target) => { const relative = path.relative(root, target); return relative === '' || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative) }

/** In-process plugin port. A provider's joint ledger remains the sole authority.
 * No model-supplied callback, synthetic session proof or mirrored commit is used.
 */
export class WorkflowRegistry {
  constructor(ctx) { this.ctx = ctx; this.entries = new Map(); this.listeners = new Set(); this.closed = false }
  register(adapter) {
    if (this.closed || adapter?.contract !== WORKFLOW_CONTRACT || !name(adapter.kind) || !name(adapter.workflowId)
        || !Number.isSafeInteger(adapter.version) || adapter.version !== 1 || typeof adapter.read !== 'function'
        || typeof adapter.execute !== 'function' || typeof adapter.authorize !== 'function'
        || !Array.isArray(adapter.operations) || adapter.operations.some(operation => !name(operation))
        || new Set(adapter.operations).size !== adapter.operations.length) fail('WORKFLOW_ADAPTER_CONTRACT_REQUIRED')
    if (typeof adapter.projectRoot !== 'string' || !path.isAbsolute(adapter.projectRoot)
        || fs.realpathSync(adapter.projectRoot) !== adapter.projectRoot || !fs.statSync(adapter.projectRoot).isDirectory()) fail('WORKFLOW_REAL_PROJECT_REQUIRED')
    const key = `${adapter.kind}:${adapter.workflowId}`
    if (this.entries.has(key)) fail('WORKFLOW_PROVIDER_ALREADY_REGISTERED')
    const entry = { ...adapter, operations: Object.freeze([...adapter.operations]), lifecycle: new AbortController() }
    this.entries.set(key, entry)
    const publish = event => {
      if (this.entries.get(key) !== entry || this.closed) return
      // Only post-commit revision metadata crosses the notification port.
      const notice = Object.freeze({ contract: WORKFLOW_CONTRACT, kind: entry.kind, workflowId: entry.workflowId,
        type: typeof event?.type === 'string' ? event.type : 'changed', revision: this.snapshot(entry).revision })
      for (const callback of this.listeners) { try { callback(notice) } catch (error) { this.ctx.logger?.warn?.(`workflow listener failed: ${error.code ?? error.name}`) } }
    }
    let unsubscribe
    try { unsubscribe = adapter.subscribe?.(publish); entry.unsubscribe = unsubscribe } catch (error) { this.entries.delete(key); throw error }
    return () => {
      if (this.entries.get(key) !== entry) return
      this.entries.delete(key); entry.lifecycle.abort(new GraphError('WORKFLOW_PROVIDER_DISPOSED')); unsubscribe?.()
    }
  }
  authorize(entry, agent) {
    if (this.closed || !agent || this.ctx.agents.get(agent.id) !== agent || this.ctx.sessions.get(agent.session.id) !== agent.session)
      fail('WORKFLOW_EXACT_CONTROLLER_REQUIRED')
    const cwd = this.ctx.get?.('workingDirectory')?.get(agent.session) ?? agent.session.header.cwd
    if (typeof cwd !== 'string' || !within(entry.projectRoot, fs.realpathSync(cwd))
        || !within(entry.projectRoot, fs.realpathSync(agent.session.header.cwd))) fail('WORKFLOW_CONTROLLER_OUTSIDE_PROJECT')
    if (entry.authorize(agent) !== true) fail('WORKFLOW_CONTROLLER_NOT_AUTHORIZED')
  }
  entry({ kind, workflowId }, agent) {
    const entry = this.entries.get(`${kind}:${workflowId}`)
    if (!entry || this.closed) fail('WORKFLOW_PROVIDER_UNAVAILABLE')
    this.authorize(entry, agent); return entry
  }
  snapshot(entry) {
    const value = copy(entry.read())
    if (!value || !Number.isSafeInteger(value.revision) || value.revision < 0 || (value.graph === null) !== (value.revision === 0)) fail('WORKFLOW_INVALID_SNAPSHOT')
    if (value.graph !== null) { validateDocument(value.graph); if (value.graph.revision !== value.revision) fail('WORKFLOW_REVISION_MISMATCH') }
    return { ...value, contract: WORKFLOW_CONTRACT, kind: entry.kind, workflowId: entry.workflowId,
      operations: [...entry.operations], goalReached: false }
  }
  list(agent) {
    const result = []
    for (const entry of this.entries.values()) {
      try { this.authorize(entry, agent) } catch { continue }
      result.push({ contract: WORKFLOW_CONTRACT, kind: entry.kind, workflowId: entry.workflowId, revision: this.snapshot(entry).revision, operations: [...entry.operations] })
    }
    return result
  }
  read(agent, reference) { return this.snapshot(this.entry(reference, agent)) }
  async dispatch(agent, reference, operation, request, signal) {
    const entry = this.entry(reference, agent)
    if (!entry.operations.includes(operation) || !request || typeof request !== 'object' || Array.isArray(request)) fail('WORKFLOW_OPERATION_NOT_SUPPORTED')
    const input = copy(request), scope = AbortSignal.any([entry.lifecycle.signal, ...(signal ? [signal] : [])])
    scope.throwIfAborted()
    const result = await entry.execute(operation, input, { agent, signal: scope })
    scope.throwIfAborted(); this.authorize(entry, agent)
    if (this.entries.get(`${entry.kind}:${entry.workflowId}`) !== entry) fail('WORKFLOW_PROVIDER_DISPOSED')
    return copy(result)
  }
  subscribe(callback) {
    if (this.closed || typeof callback !== 'function') fail('WORKFLOW_LISTENER_REQUIRED')
    this.listeners.add(callback); return () => this.listeners.delete(callback)
  }
  close() {
    if (this.closed) return
    this.closed = true
    for (const entry of this.entries.values()) { entry.lifecycle.abort(new GraphError('WORKFLOW_PROVIDER_DISPOSED')); entry.unsubscribe?.() }
    this.entries.clear(); this.listeners.clear()
  }
}
