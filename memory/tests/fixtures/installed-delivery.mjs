/** Keyless installed-bundle acceptance through a supported DSH profile and its public services. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'
import { createUserMessage, isAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { sessionFormatCatalog } from '@deepseek-ai/dsh-session-format-catalog'

/** Acceptance options; the profile supplies an explicit memory-owned evidence path. */
export const Config = z.object({
  mode: z.union(['run', 'verify']).required(), evidencePath: z.string().required(),
  expectedTokenizer: z.union(['trigram', 'unicode61']).required(), expectedRefreshIntervalMs: z.number().required(),
})
/** The installed package must supply memory; this fixture never mounts its implementation. */
export const inject = ['memory', 'agents', 'sessions', 'sessionPersistence', 'llm']

/**
 * Exercise learning, manual consumption, automatic recall and persisted model context after profile readiness.
 * @param ctx - supported profile with the independently installed memory bundle.
 * @param config - run or restart verification and expected configuration.
 */
export function apply(ctx, config) {
  const ready = ctx.get('appReady')
  const exit = ctx.get('appExit')
  if (ready === undefined || exit === undefined) throw new Error('Installed delivery requires the supported dsh launcher')
  const root = fileURLToPath(new URL('../../', import.meta.url))
  const evidencePath = resolve(config.evidencePath)
  const projectDirectory = `${evidencePath}.project`
  const suffix = relative(root, evidencePath)
  if (!suffix || suffix === '..' || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) {
    throw new Error('Installed delivery evidence must stay inside memory/')
  }
  const controller = new AbortController()
  const handles = new Set()
  const requests = []
  const knowledgeRequests = []
  let modelRequestCount = 0
  const failures = []
  let work
  ctx.on('llm/stream', (options, next) => {
    modelRequestCount++
    if (isAgentLoopRequest(options)) requests.push({ provider: options.provider, model: options.model, messages: options.messages })
    if (options.system?.startsWith('Extract project knowledge') || options.system?.startsWith('Consolidate immutable execution episodes')) {
      const text = options.messages[0].content[0].text
      const input = JSON.parse(text)
      knowledgeRequests.push({ level: input.input.level, stage: input.stage ?? 'verify-evidence',
        bytes: Buffer.byteLength(options.system) + Buffer.byteLength(text), evidence: input.evidence ?? [] })
    }
    return next()
  })
  ctx.on('agent/error', ({ agent, error }) => {
    if ([...handles].some(handle => handle.agent.id === agent.id)) failures.push(error instanceof Error ? error.message : String(error))
  }, { global: true })
  ctx.effect(() => async () => {
    controller.abort(new Error('Installed delivery unloaded'))
    await Promise.all([...handles].map(handle => handle.dispose()))
    await work
  }, 'memory.installed-delivery-lifetime')

  const run = async () => {
    for (const target of [evidencePath, projectDirectory]) {
      for (let path = target; ; path = dirname(path)) {
        let stat
        try { stat = await lstat(path) } catch (error) { if (error.code !== 'ENOENT') throw error }
        if (stat?.isSymbolicLink()) throw new Error('Installed delivery evidence or project path contains a link')
        if (path === dirname(path)) break
      }
    }
    await mkdir(dirname(evidencePath), { recursive: true })
    await mkdir(projectDirectory, { recursive: true })
    const options = { provider: 'memory-smoke', model: 'keyless' }
    const acquire = async sessionId => {
      const handle = config.mode === 'verify'
        ? await ctx.agents.resume({ resumeSessionId: SessionId(sessionId), agentOptions: options, signal: controller.signal })
        : await ctx.agents.create({ sessionId: SessionId(sessionId), meta: { cwd: projectDirectory }, agentOptions: options, signal: controller.signal })
      handles.add(handle)
      assert.equal(handle.agent.session.header.cwd, projectDirectory)
      return handle.agent
    }
    const send = async (agent, text) => {
      controller.signal.throwIfAborted()
      const offset = agent.session.seq
      const requestOffset = requests.length
      agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }))
      await agent.whenIdle()
      assert.deepEqual(failures, [])
      const events = (await persisted(agent)).events.slice(offset)
      assert.equal(events.filter(event => event.type === 'turn/end').length, 1)
      assert.equal(events.find(event => event.type === 'turn/end').data.reason.kind, 'completed')
      const admitted = requests.slice(requestOffset)
      assert.equal(admitted.length, 1)
      const recalls = events.filter(event => event.type === 'user/message' && event.data.source.kind === 'memory-recall')
      for (const event of recalls) assert.ok(admitted[0].messages.some(message => JSON.stringify(message) === JSON.stringify(event.data)))
      return recalls
    }
    const persisted = async agent => {
      await ctx.sessions.flush(agent.session)
      const handle = await ctx.sessionPersistence.open(agent.id, 'read', { signal: controller.signal })
      try {
        const { events } = await handle.read()
        assert.equal(events.length, agent.session.seq)
        return { header: handle.header, inheritedEventCount: handle.inheritedEventCount, events }
      } finally { await handle.close() }
    }
    let report
    if (config.mode === 'run') {
      const source = await acquire(`memory-installed-source-${randomUUID()}`)
      await send(source, '[安装验收长原文样例] Synthetic project constraint: use ESM modules. '
        + 'Synthetic ESM original evidence. '.repeat(1050))
      const project = ctx.memory.projectOfSession(source.id)
      assert.ok(project)
      await ctx.memory.flushLearning(project, controller.signal)
      const candidates = async level => {
        const items = []
        const limit = ctx.memory.browser.spec.pageSize
        let after = ''
        for (;;) {
          const page = await ctx.memory.listCandidates(project, level, after, limit)
          items.push(...page)
          if (page.length < limit) return items
          after = page.at(-1).id
        }
      }
      const l1 = (await candidates('L1')).find(item => item.level === 'L1' && item.sessionId === source.id)
      assert.ok(l1, 'New source Session must produce its own committed L1')
      const cites = (item, parent) => !('shared' in item) && item.knowledge.sources.some(link => link.ref.id === parent.id && link.ref.revision === parent.revision)
      const l2 = (await candidates('L2')).find(item => cites(item, l1))
      assert.ok(l2, 'New L1 must produce a committed L2 with its exact source reference')
      const l3 = (await candidates('L3')).find(item => cites(item, l2))
      assert.ok(l3, 'New L2 must produce a committed L3 with its exact source reference')
      const records = [l1, l2, l3]
      const sourceLog = await persisted(source)
      const originals = l1.summary.sources.map(ref => {
        assert.equal(ref.sessionId, source.id)
        const event = sourceLog.events[ref.seq]
        assert.equal(event.seq, ref.seq)
        return { ref, event }
      })
      const originalBytes = originals.map(item => Buffer.byteLength(JSON.stringify(item.event)))
      assert.ok(originalBytes.reduce((sum, bytes) => sum + bytes, 0) > 65536, 'One memory must require several original-event groups')
      assert.ok(originalBytes.every(bytes => bytes < 65536), 'Each original event must independently fit the configured request budget')
      const refsSorted = refs => refs.map(ref => JSON.stringify(ref)).sort()
      const sourceKnowledgeRequests = knowledgeRequests.slice()
      for (const level of ['L2', 'L3']) {
        const inspected = sourceKnowledgeRequests.filter(request => request.level === level)
        assert.ok(inspected.some(request => request.stage === 'merge-evidence'), `${level} must merge checked original-event groups`)
        assert.ok(inspected.filter(request => request.stage === 'verify-evidence').length > 1)
        assert.ok(inspected.every(request => request.bytes <= 65536))
        const provided = new Map(inspected.flatMap(request => request.evidence).map(item => [JSON.stringify(item.ref), item]))
        assert.deepEqual([...provided.keys()].sort(), refsSorted(l1.summary.sources))
        for (const original of originals) assert.deepEqual(provided.get(JSON.stringify(original.ref)), original)
      }
      assert.ok(typeof l1.summary.description === 'string' && l1.summary.description.trim())
      for (const record of [l2, l3]) {
        assert.ok(typeof record.knowledge.description === 'string' && record.knowledge.description.trim())
        assert.equal(record.config.promptVersion, 'knowledge-v4')
        assert.deepEqual(refsSorted(record.knowledge.examinedEvents), refsSorted(l1.summary.sources))
      }
      const ref = { id: l2.id, revision: l2.revision }
      const reader = await acquire(`memory-installed-reader-${randomUUID()}`)
      await ctx.sessions.flush(reader.session)
      assert.equal(ctx.memory.projectOfSession(reader.id), project)
      let position = null
      let found = false
      do {
        const page = ctx.memory.browser.browse(project, 'L2', 'Portable ESM', position)
        found ||= page.items.some(item => item.id === ref.id && item.revision === ref.revision)
        position = page.next
      } while (!found && position !== null)
      assert.ok(found)
      const selected = ctx.memory.browser.select(project, reader.id, [ref], false)
      assert.deepEqual(selected.refs, [ref])
      const first = await send(reader, 'First independent manual memory question.')
      assert.equal(first.length, 1)
      assert.equal(first[0].data.source.selectionId, selected.token)
      assert.deepEqual(ctx.memory.browser.selection(project, reader.session).refs, [])
      assert.equal((await send(reader, 'Second independent manual memory question.')).length, 0)
      ctx.memory.browser.select(project, reader.id, [], true)
      for (const text of ['Synthetic fixture ESM first automatic question.', 'Synthetic fixture ESM second automatic question.']) {
        assert.equal((await send(reader, text)).length, 1)
        assert.equal(ctx.memory.browser.selection(project, reader.session).automatic, true)
      }
      await ctx.memory.flushLearning(project, controller.signal)
      const committedRecords = await Promise.all(records.map(record => ctx.memory.getMemory(project, { id: record.id, revision: record.revision })))
      assert.ok(committedRecords.every(Boolean))
      const logs = await Promise.all([persisted(source), persisted(reader)])
      const jsonl = []
      for (const log of logs) {
        const path = `${evidencePath}.${log.header.id}.jsonl`
        const lines = [sessionFormatCatalog.encodeCurrentHeader({ ...log.header, delegationDepth: log.header.delegationDepth ?? 0 }, log.inheritedEventCount),
          ...log.events.map(event => sessionFormatCatalog.encodeCurrentEvent(event))]
        await writeFile(path, `${lines.map(line => JSON.stringify(line)).join('\n')}\n`, { flag: 'wx', mode: 0o600 })
        assert.deepEqual((await readFile(path, 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line)), lines)
        jsonl.push(path)
      }
      report = { mode: 'run', keyless: true, project, sourceSession: source.id, readerSession: reader.id,
        records: committedRecords, requests, logs, jsonl, manualOnce: true, automaticTurns: 2,
        originalEvidence: { bytes: originalBytes.reduce((sum, bytes) => sum + bytes, 0), maxEventBytes: Math.max(...originalBytes),
          refs: l1.summary.sources, requests: sourceKnowledgeRequests.map(({ evidence, ...request }) => ({ ...request, evidenceRefs: evidence.map(item => item.ref) })) },
        recallMethod: ctx.memory.recallMethod(project), refreshIntervalMs: ctx.memory.browser.spec.refreshIntervalMs }
    } else {
      const saved = JSON.parse(await readFile(evidencePath, 'utf8'))
      assert.equal(saved.mode, 'run')
      assert.equal(typeof saved.sourceSession, 'string')
      assert.equal(typeof saved.readerSession, 'string')
      assert.equal(typeof saved.project, 'string')
      assert.ok(Array.isArray(saved.records) && saved.records.length === 3)
      assert.ok(Array.isArray(saved.logs) && saved.logs.length === 2)
      for (const record of saved.records) {
        assert.equal(typeof record.id, 'string')
        assert.ok(Number.isSafeInteger(record.revision) && record.revision > 0)
      }
      const source = await acquire(saved.sourceSession)
      const reader = await acquire(saved.readerSession)
      await ctx.sessions.flush(source.session)
      await ctx.sessions.flush(reader.session)
      const project = ctx.memory.projectOfSession(reader.id)
      assert.equal(project, saved.project)
      assert.equal(ctx.memory.projectOfSession(source.id), project)
      const recordStates = []
      for (const record of saved.records) {
        const ref = { id: record.id, revision: record.revision }
        const retained = await ctx.memory.getMemory(project, ref)
        assert.ok(retained)
        const { state: previousState, ...previousContent } = record
        const { state, ...content } = retained
        assert.deepEqual(content, previousContent)
        recordStates.push({ ref, previousState, state })
      }
      const resumeSuffixes = []
      for (const [agent, previous] of [[source, saved.logs[0]], [reader, saved.logs[1]]]) {
        const log = await persisted(agent)
        assert.deepEqual(log.header, previous.header)
        assert.equal(log.inheritedEventCount, previous.inheritedEventCount)
        assert.deepEqual(log.events.slice(0, previous.events.length), previous.events)
        const suffix = log.events.slice(previous.events.length)
        // Session restoration appends one ordinary marker unless the stored tail already ends in it.
        assert.ok(suffix.length <= 1)
        for (const event of suffix) {
          assert.equal(event.type, 'session/end-seed')
          assert.deepEqual(event.data, {})
          assert.equal(event.seq, previous.events.length)
        }
        resumeSuffixes.push({ sessionId: agent.id, count: suffix.length, eventTypes: suffix.map(event => event.type) })
      }
      assert.deepEqual(ctx.memory.browser.selection(project, reader.session).refs, [])
      assert.equal(ctx.memory.browser.selection(project, reader.session).automatic, true)
      assert.equal(requests.length, 0)
      assert.equal(modelRequestCount, 0)
      report = { mode: 'verify', keyless: true, project, sourceSession: source.id, readerSession: reader.id,
        recordsRetained: 3, recordStates, logsRetained: true, resumeSuffixes, newModelRequests: 0, newRecalls: 0, automaticRetained: true,
        recallMethod: ctx.memory.recallMethod(project), refreshIntervalMs: ctx.memory.browser.spec.refreshIntervalMs }
    }
    assert.equal(report.recallMethod, config.expectedTokenizer)
    assert.equal(report.refreshIntervalMs, config.expectedRefreshIntervalMs)
    assert.deepEqual(failures, [])
    await writeFile(config.mode === 'run' ? evidencePath : `${evidencePath}.verified-${config.expectedTokenizer}.json`, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    for (const handle of handles) await handle.dispose()
    handles.clear()
    return { mode: report.mode, passed: true, evidencePath, recallMethod: report.recallMethod, refreshIntervalMs: report.refreshIntervalMs }
  }
  ctx.effect(() => ready.onReady(() => {
    work = run().then(report => {
      console.log(`MEMORY_INSTALLED_DELIVERY ${JSON.stringify(report)}`)
      exit(0)
    }, error => {
      console.error(`MEMORY_INSTALLED_DELIVERY ${JSON.stringify({ passed: false, mode: config.mode, error: error instanceof Error ? error.stack : String(error) })}`)
      exit(1)
    })
  }), 'memory.installed-delivery-ready')
}
