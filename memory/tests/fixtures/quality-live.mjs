/** Bounded real-provider memory/control experiment loaded only by the supported dsh profile. */
import { mkdir, mkdtemp, readFile, writeFile, copyFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { BlockAssembler, ToolCallId, createUserMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import { Config, SqliteMemory, TextMemoryRetriever, MemoryRequestJournal, L1Extractor, L1Worker,
  KnowledgeExtractor, KnowledgeWorker, resolveConfig } from '../../lib/index.mjs'
import { ExperimentBudget, grade, selectFixedCases, experimentCompletion, experimentAcceptance } from '../../evaluation/quality-runner.mjs'
export { Config }
export const name = 'memory-quality-live'
export const inject = ['llm', 'agentDefaultModel']
const root = fileURLToPath(new URL('../../', import.meta.url))

/** Dispatch fixed synthetic learning data through real extractors; retain all requests and results. */
export function apply(ctx, config) {
  const exit = ctx.get('appExit')
  if (exit === undefined) throw new Error('Quality evaluation requires the supported dsh launcher')
  let work
  ctx.effect(() => async () => { await work?.catch(() => undefined) }, 'memory.quality-live')
  const run = async () => {
    await ctx.get('loader')?.await()
    const inputs = JSON.parse(await readFile(join(root, 'evaluation/task4-cases.json'), 'utf8'))
    const selection = selectFixedCases(inputs.cases, process.env.DSH_MEMORY_EVALUATION_CASES)
    await mkdir(join(root, '.artifacts'), { recursive: true })
    const directory = await mkdtemp(join(root, '.artifacts/quality-'))
    const model = ctx.agentDefaultModel.currentSelection()
    const reusePath = process.env.DSH_MEMORY_EVALUATION_REUSE_REPORT
    const reuse = reusePath === undefined ? undefined : JSON.parse(await readFile(reusePath, 'utf8'))
    const reuseIds = new Set((process.env.DSH_MEMORY_EVALUATION_REUSE_CASES ?? '').split(',').filter(Boolean))
    const budget = new ExperimentBudget(inputs.protocol.hardLimits)
    for (const entry of await readdir(join(root, '.artifacts'), { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith('quality-') || join(root, '.artifacts', entry.name) === directory) continue
      const priorPath = join(root, '.artifacts', entry.name, 'report.json')
      let prior
      try { prior = JSON.parse(await readFile(priorPath, 'utf8')) }
      catch (error) { if (error.code === 'ENOENT') continue; throw error }
      if (prior.kind === 'fixed-real-provider-paired-memory-quality') budget.importPrior(prior, priorPath)
    }
    let phase = 'learning'
    const llm = budget.wrap(ctx.llm, () => phase)
    const report = { kind: 'fixed-real-provider-paired-memory-quality', model, protocol: inputs.protocol,
      directory, cases: [], completed: false, passed: false,
      cumulativeBudget: true,
      mode: selection.mode, selectedCaseIds: selection.caseIds,
      diagnosticOnly: selection.mode === 'diagnostic-subset',
      ...(selection.mode === 'full' ? {} : { doesNotReplaceFullExperiment: true }),
      modelSettings: { thinking: 'disabled', reasoningEffort: 'off' },
      ...(reuse === undefined ? {} : { protocolDeviation: { reusedReport: reusePath, reusedCases: [...reuseIds],
        explanation: 'Completed high-effort pairs are retained in a separate stratum; remaining cases use reasoning off equally for learning and both answer arms.' } }),
      exclusions: ['Small fixed sample; no claim of general long-term quality', 'Answer generation uses the configured framework LLM service, with recorded retrieval, rather than a GUI agent turn'] }
    const prices = process.env.DSH_MEMORY_EVALUATION_PRICES === undefined ? undefined : JSON.parse(await readFile(process.env.DSH_MEMORY_EVALUATION_PRICES, 'utf8'))
    budget.report(prices)
    const save = async () => { report.budget = budget.report(prices); await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n') }
    const specFor = databasePath => resolveConfig({ ...config, dataRoot: directory, databasePath, projectId: 'A',
      autoLearning: false, textSearch: { tokenizer: 'unicode61', expandQuery: false },
      l1: { provider: model.provider, model: model.model, maxOutputTokens: 2048, maxCalls: 2, maxAttempts: 1, timeoutMs: 60000 },
      knowledge: { provider: model.provider, model: model.model, maxOutputTokens: 2048, maxCalls: 3, maxAttempts: 1, timeoutMs: 60000 } })
    for (const [caseIndex, item] of inputs.cases.entries()) {
      if (!selection.caseIds.includes(item.id)) continue
      if (budget.stopped) break
      if (reuseIds.has(item.id)) {
        const existing = structuredClone(reuse?.cases.find(value => value.id === item.id))
        if (existing === undefined || existing.repetitions.length !== 3 || !existing.repetitions.every(pair => pair.arms.length === 2 && pair.arms.every(arm => arm.completed))) throw new Error('Only complete paired cases may be reused')
        existing.modelSettings = { thinking: 'enabled', reasoningEffort: 'high' }
        existing.reusedFrom = reusePath
        for (const pair of existing.repetitions) for (const arm of pair.arms) Object.assign(arm, grade(item, arm.answer, arm.hits.map(hit => hit.text)))
        report.cases.push(existing)
        await save()
        continue
      }
      const result = { id: item.id, learningFailures: [], learningTasks: [], repetitions: [], isolationPassed: null, wrongKnowledge: 0, checkedKnowledge: 0,
        modelSettings: report.modelSettings, knowledgeErrorAssessment: item.toolResult === undefined ? 'not assessed' : 'contradictory-status execution evidence only' }
      report.cases.push(result)
      const seed = join(directory, `${item.id}-learn.sqlite`)
      const spec = await specFor(seed)
      result.promptVersions = { l1: spec.l1.promptVersion, knowledge: spec.knowledge.promptVersion }
      let memory = await SqliteMemory.open(spec)
      const journal = new MemoryRequestJournal(memory, llm)
      const l1Worker = new L1Worker(memory, new L1Extractor(journal, journal.recordL1), spec.projectId, spec.pageSize,
        (_operation, failure) => result.learningFailures.push(failure))
      const extractor = new KnowledgeExtractor(journal, journal.recordKnowledge, SessionId(`quality-${item.id}`),
        (project, ref) => memory.knowledge.sourcesCurrent(project, ref), async (project, ref, signal) => {
          const page = await memory.readRaw({ projectId: project, sessionId: ref.sessionId, from: ref.seq, to: ref.seq + 1, limit: 1, signal })
          if (page.events[0] === undefined) throw new Error('Quality source event unavailable')
          return page.events[0]
        })
      const knowledgeWorker = new KnowledgeWorker(memory.knowledge, extractor)
      try {
        phase = `learning:${item.id}`
        for (const [index, text] of [item.learn, ...item.distractor === undefined ? [] : [item.distractor]].entries()) {
          const source = Session.create(SessionId(`quality-${item.id}-${index}-${randomUUID()}`))
          source.append('turn/start', { turn: 1 })
          source.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }), { surfaceOp: 'append' })
          if (item.toolResult !== undefined && index === 0) {
            const callId = ToolCallId(`quality-tool-${item.id}`)
            source.append('tool/call', { turn: 1, step: 1, callId, name: 'run_checks', arguments: '{}' })
            source.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId,
              isError: false, content: [{ type: 'text', text: JSON.stringify(item.toolResult) }] }) }, { surfaceOp: 'append' })
          }
          source.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
          await memory.appendRaw({ projectId: spec.projectId, header: source.header, inheritedEventCount: source.inheritedEventCount, events: source.snapshotEvents() })
          await memory.scanTurns(spec.projectId, spec.l1, spec.pageSize)
          await l1Worker.flush(source.id)
          const l1Tasks = await memory.l1.listTasks(spec.projectId, '', spec.pageSize)
          for (const task of l1Tasks) {
            result.learningTasks.push({ level: 'L1', status: task.status, calls: task.calls })
            const record = await memory.l1.byOperation(spec.projectId, task.operationId)
            if (record !== null && item.toolResult !== undefined && (record.summary.executionEvidence?.length ?? 0) > 0) result.wrongKnowledge++
          }
          const levels = item.highestLevel === 'L1' ? [] : item.highestLevel === 'L2' ? ['L2'] : ['L2', 'L3']
          for (const level of levels) {
            await memory.knowledge.enqueueCandidates(spec.projectId, level, spec.knowledge, spec.pageSize)
            for (const task of await memory.knowledge.listTasks(spec.projectId, '', spec.pageSize)) {
              if (task.input.level !== level) continue
              if (task.status !== 'done') await knowledgeWorker.run(spec.projectId, task.operationId, new AbortController().signal)
              const settled = await memory.knowledge.getTask(spec.projectId, task.operationId)
              result.learningTasks.push({ level, status: settled.status, calls: settled.calls })
              if (settled.status === 'failed') result.learningFailures.push({ level, code: settled.failure })
            }
          }
        }
        for (const level of ['L1', 'L2', 'L3']) {
          const records = await memory.knowledge.listCandidates(spec.projectId, level, '', 100)
          result.checkedKnowledge += records.length
          if (item.toolResult !== undefined) result.wrongKnowledge += records.filter(record => record.level !== 'L1' && record.knowledge.evidenceStatus === 'execution_verified').length
        }
        if (item.share !== undefined) {
          const shared = (await memory.knowledge.listCandidates(spec.projectId, 'L3', '', 100))[0]
          if (shared === undefined) throw new Error('No eligible L3 guideline was learned for sharing')
          const action = action => ({ operationId: randomUUID(), projectId: spec.projectId, ref: { id: shared.id, revision: shared.revision },
            action, userId: 'fixed-experiment-user', receiptId: randomUUID(), occurredAt: Date.now(), expiresAt: Date.now() + 60000 })
          await memory.knowledge.approveShare(action('approve'), () => true, Date.now())
          result.approvedRef = { id: shared.id, revision: shared.revision }
          if (item.share === 'revoke') await memory.knowledge.revokeShare(action('revoke'), () => true, Date.now())
        }
      } catch (error) { result.learningFailures.push({ code: error.code ?? error.name, message: error.message }) }
      finally { await l1Worker.close(); await knowledgeWorker.close(); await memory.close() }
      await save()
      if (result.learningFailures.some(failure => failure.code === 'MISSING_CREDENTIAL')) {
        report.prerequisiteFailure = 'MISSING_CREDENTIAL'
        break
      }
      for (let repetition = 0; repetition < inputs.protocol.repetitions && !budget.stopped; repetition++) {
        const pair = { repetition, arms: [] }
        result.repetitions.push(pair)
        const arms = (caseIndex + repetition) % 2 ? ['memory', 'control'] : ['control', 'memory']
        for (const arm of arms) {
          if (budget.stopped) break
          const databasePath = join(directory, `${item.id}-${repetition}-${arm}.sqlite`)
          await copyFile(seed, databasePath)
          const armSpec = await specFor(databasePath)
          memory = await SqliteMemory.open(armSpec)
          const retriever = new TextMemoryRetriever(memory, armSpec.textSearch)
          const answerJournal = new MemoryRequestJournal(memory, llm)
          const project = item.queryProject ?? armSpec.projectId
          const record = { arm, completed: false, correct: false, steps: 0 }
          pair.arms.push(record)
          try {
            const start = performance.now()
            const retrieval = arm === 'control' ? { hits: [], text: '', elapsedMs: 0 }
              : await retriever.retrieve({ projectId: project, text: item.ask, levels: item.highestLevel === undefined ? ['L1', 'L2', 'L3'] : [item.highestLevel] })
            record.retrievalMs = performance.now() - start
            record.hits = retrieval.hits
            const request = { provider: model.provider, model: model.model, maxTokens: 512,
              system: 'Answer only from supplied project facts when the question is project-specific. If information is absent, answer unknown. Return JSON only: {"answer":"concise answer in English","verified":false}. Set verified true only for recorded consistent successful execution.',
              messages: [{ role: 'user', content: [{ type: 'text', text: `${item.ask}\n\n${retrieval.text}` }] }], sessionId: SessionId(`answer-${randomUUID()}`), signal: AbortSignal.timeout(60000) }
            const { signal, ...recordedRequest } = request
            await answerJournal.recordQuery(project, recordedRequest, signal)
            phase = `answer:${item.id}:${repetition}:${arm}`
            const assembler = new BlockAssembler()
            for await (const chunk of answerJournal.stream(request)) assembler.push(chunk)
            record.steps = 1
            record.completed = assembler.finish?.kind === 'stop'
            record.answer = assembler.blocks().flatMap(block => block.type === 'text' ? [block.text] : []).join('')
            record.usage = assembler.usage ?? null
            Object.assign(record, grade(item, record.answer, retrieval.hits.map(hit => hit.text)))
            record.elapsedMs = performance.now() - start
          } catch (error) { record.failure = { code: error.code ?? error.name, message: error.message } }
          finally { await retriever.close(); await memory.close() }
          await save()
        }
      }
      if (['private-project', 'revoked-shared', 'contradictory-success', 'contradictory-zero'].includes(item.id)) {
        result.isolationPassed = result.learningFailures.length === 0 && result.checkedKnowledge > 0
          && result.wrongKnowledge === 0 && result.repetitions.length === 3
          && result.repetitions.every(pair => pair.arms.length === 2 && pair.arms.every(arm => arm.completed && arm.correct
            && (arm.arm === 'control' || item.expectedVerified !== undefined || arm.hits?.length === 0)))
      }
      if (item.id === 'approved-shared') result.isolationPassed = result.approvedRef !== undefined && result.learningFailures.length === 0
        && result.repetitions.length === 3 && result.repetitions.every(pair => pair.arms.find(arm => arm.arm === 'memory')?.correct)
    }
    const allArms = report.cases.flatMap(item => item.repetitions.flatMap(pair => pair.arms))
    Object.assign(report, experimentCompletion(report.cases, selection, inputs.protocol.repetitions, budget.stopped))
    report.metrics = Object.fromEntries(['control', 'memory'].map(arm => [arm, {
      correct: allArms.filter(record => record.arm === arm && record.correct).length,
      completed: allArms.filter(record => record.arm === arm && record.completed).length }]))
    const acceptance = experimentAcceptance(report.cases, inputs.cases, report.completed)
    report.passed = acceptance.passed
    report.acceptanceChecks = acceptance.checks
    await save()
    console.log(JSON.stringify({ directory, mode: report.mode, completed: report.completed, diagnosticCompleted: report.diagnosticCompleted,
      passed: report.passed, metrics: report.metrics, budget: { ...budget.report(prices), calls: undefined } }))
    return report
  }
  work = run()
  void work.then(report => exit(report.passed ? 0 : 1), error => { console.error(JSON.stringify({ qualityFailure: error.message })); exit(1) })
}
