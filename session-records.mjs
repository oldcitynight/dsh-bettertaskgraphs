// SPDX-License-Identifier: GPL-3.0-only
import path from 'node:path'
import fs from 'node:fs'
import { canonical, copy, digest, GraphError } from './core.mjs'
import { FileGraphStore } from './store.mjs'
import { applyEvent, initialState } from './projection.mjs'

const firstRecord = 2 ** 52
const isPluginType = type => typeof type === 'string' && /^plugin:[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/.test(type)
const abort = code => { throw new GraphError(code) }
const recordLimit = 4096
const normalizedHeader = header => ({ ...header, delegationDepth: header.delegationDepth ?? 0 })

/** For DSH releases before appendPluginRecord. Native log positions and bytes
 * stay intact. A separate, exact-owner journal supplies plugin facts only. */
export class LegacySessionRecords {
  constructor(ctx) {
    this.ctx = ctx
    this.projected = new WeakMap()
  }
  binding(session) {
    if (this.ctx.sessions.get(session.id) !== session || session.header.id !== session.id
        || !Number.isSafeInteger(session.header.createdAt)) abort('SESSION_NOT_EXACT_LIVE_OWNER')
    return digest({ header: normalizedHeader(session.header), inheritedEventCount: session.inheritedEventCount })
  }
  root(create = false) {
    const configured = this.ctx.sessionPersistence.config?.root
    if (typeof configured !== 'string' || !path.isAbsolute(configured)) abort('LEGACY_RECORDS_REQUIRE_JSONL_ROOT')
    if (create) fs.mkdirSync(configured, { recursive: true, mode: 0o700 })
    return fs.realpathSync(configured)
  }
  directory(session, root = this.root()) { return path.join(root, '.taskgraph-session-records-v1', digest(session.id)) }
  marker(session, root) { return path.join(root, `.taskgraph-record-${digest(session.id)}`) }
  validate(value, binding) {
    if (!value || value.schema !== 1 || value.binding !== binding || !Array.isArray(value.rows)
        || value.revision !== value.rows.length || value.revision < 1 || value.revision > recordLimit
        || digest({ schema: value.schema, binding: value.binding, revision: value.revision, rows: value.rows }) !== value.checksum)
      abort('LEGACY_SESSION_RECORD_JOURNAL_INVALID')
    let last = -1
    for (const [index, row] of value.rows.entries()) {
      if (!row?.event || !Number.isSafeInteger(row.event.time) || !Object.hasOwn(row.event, 'data')
          || row.event.seq !== firstRecord + index || row.event.ignorable !== true || !isPluginType(row.event.type)
          || !Number.isSafeInteger(row.anchor) || row.anchor < 0 || row.anchor >= firstRecord
          || row.anchor < last || (row.anchor === 0 ? row.anchorDigest !== null : !/^[a-f0-9]{64}$/.test(row.anchorDigest)))
        abort('LEGACY_SESSION_RECORD_ANCHOR_INVALID')
      last = row.anchor
    }
  }
  store(session, readOnly) {
    const binding = this.binding(session)
    const root = this.root(!readOnly)
    return new FileGraphStore({ projectRoot: root, directory: this.directory(session, root), readOnly,
      fileName: 'records.json', maximumBytes: 12 * 1024 * 1024,
      validator: value => this.validate(value, binding),
      updateValidator(previous, next) {
        if (next.revision !== (previous?.revision ?? 0) + 1
            || previous && canonical(next.rows.slice(0, -1)) !== canonical(previous.rows))
          abort('LEGACY_SESSION_RECORD_HISTORY_CHANGED')
      },
    })
  }
  read(session, events = session.snapshotEvents()) {
    let journal
    try { journal = this.store(session, true).read() } catch (error) {
      if (error.code !== 'ENOENT') throw error
      try {
        if (fs.existsSync(this.marker(session, this.root()))) abort('LEGACY_SESSION_RECORD_JOURNAL_MISSING')
      } catch (missingRoot) { if (missingRoot.code !== 'ENOENT') throw missingRoot }
      return []
    }
    if (!journal) {
      // The independently written admission marker distinguishes an absent
      // record stream from a session that has never used the plugin.
      if (fs.existsSync(this.marker(session, this.root()))) abort('LEGACY_SESSION_RECORD_JOURNAL_MISSING')
      return []
    }
    const marker = this.marker(session, this.root())
    const fd = fs.openSync(marker, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
    try {
      const info = fs.fstatSync(fd)
      if (!info.isFile() || info.nlink !== 1 || info.size !== 65 || fs.readFileSync(fd, 'utf8') !== journal.binding + '\n')
        abort('LEGACY_SESSION_RECORD_BINDING_INVALID')
    } finally { fs.closeSync(fd) }
    const rows = journal.rows
    for (const { anchor, anchorDigest } of rows) {
      if (anchor < session.inheritedEventCount || anchor > events.length
          || anchor && digest(events[anchor - 1]) !== anchorDigest)
        abort('LEGACY_SESSION_NATIVE_ANCHOR_CHANGED')
    }
    return rows
  }
  append(session, type, data) {
    if (!isPluginType(type)) abort('INVALID_PLUGIN_RECORD_TYPE')
    const events = session.snapshotEvents(), anchor = events.length
    const anchorDigest = anchor ? digest(events[anchor - 1]) : null
    const prior = this.read(session, events)
    if (prior.length >= recordLimit) abort('LEGACY_SESSION_RECORD_LIMIT')
    const serialized = JSON.stringify(data)
    if (serialized === undefined || canonical(JSON.parse(serialized)) !== canonical(data))
      abort('LEGACY_SESSION_RECORD_DATA_INVALID')
    const seq = firstRecord + prior.length, binding = this.binding(session)
    const store = this.store(session, false)
    const root = this.root()
    const marker = this.marker(session, root)
    if (!prior.length) {
      const fd = fs.openSync(marker, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600)
      try { fs.writeFileSync(fd, binding + '\n'); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
      const directory = fs.openSync(root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY)
      try { fs.fsyncSync(directory) } finally { fs.closeSync(directory) }
    }
    // Compare JSON round-trip bytes before reserving a durable record.
    // Replay consumes the same data shape that the writer observed.
    const row = { anchor, anchorDigest, event: { type, seq, time: Date.now(), ignorable: true, data: copy(data) } }
    store.compareAndSwap(prior.length, previous => {
      const document = { schema: 1, binding, revision: prior.length + 1, rows: [...(previous?.rows ?? []), row] }
      return { ...document, checksum: digest(document) }
    })
    return seq
  }
  projection(session) {
    const events = session.snapshotEvents()
    const rows = this.read(session, events)
    const prior = this.projected.get(session)
    const samePrefix = prior && prior.events.length <= events.length
      && events[prior.events.length - 1] === prior.events.at(-1)
      && prior.rows.length <= rows.length
      && prior.rows.every((row, i) => canonical(row) === canonical(rows[i]))
      && (rows.length === prior.rows.length || rows[prior.rows.length].anchor >= prior.events.length)
    let position = samePrefix ? prior.events.length : session.inheritedEventCount
    let state = samePrefix ? prior.state : initialState(session.header, session.inheritedEventCount)
    for (const { anchor, event } of rows.slice(samePrefix ? prior.rows.length : 0)) {
      while (position < anchor) state = applyEvent(state, events[position++])
      // A synthetic record id must never widen the admitted native evidence range.
      const lastSeq = state.lastSeq
      state = { ...applyEvent(state, event), lastSeq }
    }
    while (position < events.length) state = applyEvent(state, events[position++])
    this.projected.set(session, { events, rows, state })
    return state
  }
  async verify(session, handle, proof) {
    if (proof.seq < firstRecord) return false
    const row = this.read(session).at(proof.seq - firstRecord)
    if (!row || row.event.seq !== proof.seq || digest(row.event) !== proof.digest)
      abort('LEGACY_SESSION_RECORD_PROOF_REQUIRED')
    if (row.anchor) {
      const { events } = await handle.read(row.anchor - 1, 1)
      if (events.length !== 1 || events[0].seq !== row.anchor - 1 || digest(events[0]) !== row.anchorDigest)
        abort('DURABLE_SESSION_EVENT_PROOF_REQUIRED')
    }
    return true
  }
}
