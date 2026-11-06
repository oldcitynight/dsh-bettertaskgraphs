import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { TransactionGraph, GraphError } from '../core.mjs'
import { FileGraphStore } from '../store.mjs'

const definition = { title: 'Private file fixture', nodes: [
  { key: 'root', kind: 'container', label: 'Root' }, { key: 'one', kind: 'leaf', label: 'One', parent: 'root' },
], edges: [] }
function environment(t) {
  const projectRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'transaction-graph-test-')))
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }))
  return { projectRoot, directory: path.join(projectRoot, 'private', 'graph') }
}
const code = expected => error => error instanceof GraphError && error.code === expected

test('explicit private project path and every directory component are required', t => {
  const options = environment(t)
  assert.throws(() => new FileGraphStore({ directory: options.directory }), code('EXPLICIT_ABSOLUTE_STORE_ROOT_REQUIRED'))
  assert.throws(() => new FileGraphStore({ projectRoot: options.projectRoot, directory: path.dirname(options.projectRoot) }), code('STORE_OUTSIDE_PROJECT'))
  assert.throws(() => new FileGraphStore({ projectRoot: options.projectRoot, directory: options.projectRoot }), code('STORE_OUTSIDE_PROJECT'))
})
test('CAS atomically persists one document containing plan, state and replayable events; restart keeps ACTIVE', t => {
  const options = environment(t), store = new FileGraphStore(options), first = new TransactionGraph(store)
  first.create({ operationId: 'create', definition })
  first.begin({ expectedRevision: 1, operationId: 'begin', choice: 0 })
  const restartedStore = new FileGraphStore(options), restarted = new TransactionGraph(restartedStore)
  assert.equal(restarted.read().revision, 2)
  assert.equal(restarted.read().active.recoveryRequired, true)
  assert.equal(restartedStore.read().events.length, 2)
  assert.deepEqual(fs.readdirSync(options.directory), ['transaction-graph.json'])
  assert.throws(() => restarted.begin({ expectedRevision: 2, operationId: 'replay', choice: 0 }), code('RECOVERY_REQUIRED'))
})
test('another store view cannot commit an old revision and cannot overwrite history', t => {
  const options = environment(t), store = new FileGraphStore(options), stale = new FileGraphStore(options)
  const graph = new TransactionGraph(store); graph.create({ operationId: 'create', definition })
  assert.throws(() => stale.compareAndSwap(0, () => null), code('CAS_CONFLICT'))
  assert.equal(store.read().revision, 1)
})
test('leftover lock is never stolen after a crash and blocks replay', t => {
  const options = environment(t), store = new FileGraphStore(options)
  fs.mkdirSync(store.lock)
  fs.writeFileSync(path.join(store.lock, 'owner.json'), JSON.stringify({ token: 'prior-owner-no-assumed-liveness' }))
  assert.throws(() => new TransactionGraph(store).create({ operationId: 'create', definition }), code('CAS_LOCK_BUSY_NO_AUTOMATIC_STEAL'))
  assert.equal(fs.existsSync(store.lock), true)
  assert.equal(fs.existsSync(store.file), false)
})
test('symlinked directory escaping the project is rejected before touching its target', t => {
  const options = environment(t), outside = fs.mkdtempSync(path.join(os.tmpdir(), 'transaction-graph-outside-'))
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }))
  fs.symlinkSync(outside, path.join(options.projectRoot, 'escape'), 'dir')
  assert.throws(() => new FileGraphStore({ projectRoot: options.projectRoot, directory: path.join(options.projectRoot, 'escape', 'state') }), code('STORE_SYMLINK_OR_NOT_DIRECTORY'))
  assert.deepEqual(fs.readdirSync(outside), [])
})
test('symlinked state file is rejected; external contents are preserved', t => {
  const options = environment(t), store = new FileGraphStore(options), target = path.join(options.projectRoot, 'external-fixture.txt')
  fs.writeFileSync(target, 'preserve-this-fixture')
  fs.symlinkSync(target, store.file)
  assert.throws(() => store.read(), error => error.code === 'ELOOP')
  assert.equal(fs.readFileSync(target, 'utf8'), 'preserve-this-fixture')
})
test('directory identity replacement invalidates an existing store handle', t => {
  const options = environment(t), store = new FileGraphStore(options)
  fs.renameSync(options.directory, options.directory + '-old')
  fs.mkdirSync(options.directory)
  assert.throws(() => store.read(), code('STORE_DIRECTORY_IDENTITY_CHANGED'))
})
test('malformed or checksum-corrupt record fails closed instead of silently starting a new graph', t => {
  const options = environment(t), store = new FileGraphStore(options), graph = new TransactionGraph(store)
  graph.create({ operationId: 'create', definition })
  const value = JSON.parse(fs.readFileSync(store.file, 'utf8')); value.checksum = '0'.repeat(64)
  fs.writeFileSync(store.file, JSON.stringify(value))
  assert.throws(() => store.read(), code('DOCUMENT_CHECKSUM'))
  assert.throws(() => graph.create({ operationId: 'new_create', definition }), code('DOCUMENT_CHECKSUM'))
})
test('failed mutation leaves original state intact, removes only its own temporary lock', t => {
  const options = environment(t), store = new FileGraphStore(options), graph = new TransactionGraph(store)
  graph.create({ operationId: 'create', definition })
  const before = fs.readFileSync(store.file, 'utf8')
  assert.throws(() => store.compareAndSwap(1, () => { throw new Error('simulated validation failure before commit') }), /simulated validation failure/)
  assert.equal(fs.readFileSync(store.file, 'utf8'), before)
  assert.equal(fs.existsSync(store.lock), false)
})
