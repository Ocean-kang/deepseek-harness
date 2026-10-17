/** Budget accounting and deterministic rubrics for the fixed live memory experiment. */
import { isDeepStrictEqual } from 'node:util'

export class ExperimentBudget {
  constructor(limits = { calls: 240, inputTokens: 2000000, outputTokens: 250000 }) {
    this.limits = limits
    this.calls = []
    this.reservedInput = 0
    this.reservedOutput = 0
    this.stopped = false
  }
  /** Reserve pessimistic UTF-8 input bytes and requested output tokens before dispatch. */
  reserve(request, phase) {
    const input = Buffer.byteLength(JSON.stringify({ system: request.system, messages: request.messages, tools: request.tools })) + 1024
    const output = request.maxTokens
    if (!Number.isSafeInteger(output) || output < 1) throw new Error('Every evaluation request needs an explicit positive maxTokens')
    if (this.calls.length >= this.limits.calls || this.reservedInput + input > this.limits.inputTokens
      || this.reservedOutput + output > this.limits.outputTokens) {
      this.stopped = true
      throw new Error('EXPERIMENT_BUDGET_EXHAUSTED')
    }
    this.reservedInput += input
    this.reservedOutput += output
    const call = { phase, provider: request.provider, model: request.model, reservedInput: input, reservedOutput: output, usage: null, outcome: 'unknown' }
    this.calls.push(call)
    return call
  }
  /** Retain earlier attempts from this fixed experiment; already imported entries are counted only at their original report. */
  importPrior(report, path) {
    for (const prior of report.budget.calls.filter(call => call.priorReport === undefined)) {
      if (!Number.isSafeInteger(prior.reservedInput) || prior.reservedInput < 0 || !Number.isSafeInteger(prior.reservedOutput) || prior.reservedOutput < 0) throw new Error('Invalid prior experiment reservation')
      this.calls.push({ ...prior, priorReport: path })
      this.reservedInput += prior.chargedInput ?? prior.reservedInput
      this.reservedOutput += prior.chargedOutput ?? prior.reservedOutput
    }
    if (report.interruptedReservation !== undefined) {
      const prior = report.interruptedReservation
      this.calls.push({ ...prior, priorReport: path })
      this.reservedInput += prior.reservedInput
      this.reservedOutput += prior.reservedOutput
    }
  }
  /** A wrapper charges every framework stream dispatch, including retries and expansion. */
  wrap(llm, phase) {
    const owner = this
    return { async *stream(request) {
      const call = owner.reserve(request, typeof phase === 'function' ? phase() : phase)
      const start = performance.now()
      try {
        for await (const chunk of llm.stream(request)) {
          if (chunk.type === 'usage') call.usage = chunk.usage
          if (chunk.type === 'finish') call.outcome = chunk.reason?.kind ?? chunk.finish?.kind ?? 'returned'
          yield chunk
        }
        if (call.outcome === 'unknown') call.outcome = 'returned'
      } catch (error) { call.outcome = 'threw'; throw error }
      finally {
        call.elapsedMs = performance.now() - start
        if (call.outcome === 'stop' && call.usage !== null) {
          const usage = call.usage
          call.chargedInput = usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
          call.chargedOutput = usage.outputTokens
          owner.reservedInput += call.chargedInput - call.reservedInput
          owner.reservedOutput += call.chargedOutput - call.reservedOutput
        }
      }
    } }
  }
  /** Totals remain unknown for calls whose provider returned no usage. Prices are per million tokens. */
  report(prices) {
    if (prices !== undefined && (typeof prices.currency !== 'string' || prices.currency.trim() === ''
      || !['inputPerMillion', 'outputPerMillion'].every(field => Number.isFinite(prices[field]) && prices[field] >= 0))) {
      throw new Error('Evaluation prices require a currency and finite non-negative inputPerMillion/outputPerMillion')
    }
    const known = this.calls.filter(call => call.usage !== null)
    const inputTokens = known.reduce((total, call) => total + call.usage.inputTokens + (call.usage.cacheReadTokens ?? 0) + (call.usage.cacheWriteTokens ?? 0), 0)
    const outputTokens = known.reduce((total, call) => total + call.usage.outputTokens, 0)
    const phases = Object.fromEntries(['learning', 'expansion', 'answer'].map(phase => {
      const calls = this.calls.filter(call => call.phase.split(':')[0] === phase)
      const known = calls.filter(call => call.usage !== null)
      return [phase, { requests: calls.length, unknownUsageCalls: calls.length - known.length,
        inputTokens: known.reduce((total, call) => total + call.usage.inputTokens + (call.usage.cacheReadTokens ?? 0) + (call.usage.cacheWriteTokens ?? 0), 0),
        outputTokens: known.reduce((total, call) => total + call.usage.outputTokens, 0) }]
    }))
    return { requests: this.calls.length, currentRunRequests: this.calls.filter(call => call.priorReport === undefined).length,
      inputTokens, outputTokens, unknownUsageCalls: this.calls.length - known.length, phases,
      reservedInputTokens: this.reservedInput, reservedOutputTokens: this.reservedOutput, stopped: this.stopped,
      cost: known.length !== this.calls.length || prices === undefined ? 'unknown' : {
        currency: prices.currency, amount: (inputTokens * prices.inputPerMillion + outputTokens * prices.outputPerMillion) / 1000000 }, calls: this.calls }
  }
}

/** Select reviewed fixed cases without accepting new case text or changing full-experiment acceptance.
 * @param cases - fixed reviewed case definitions.
 * @param requested - optional comma-separated subset of existing IDs.
 * @returns selection mode and exact case IDs.
 */
export function selectFixedCases(cases, requested) {
  const available = new Set(cases.map(item => item.id))
  const ids = requested === undefined ? [...available] : requested.split(',').map(id => id.trim())
  if (ids.length === 0 || ids.some(id => id === '' || !available.has(id)) || new Set(ids).size !== ids.length) throw new Error('Evaluation case selection must contain unique IDs from the twelve fixed cases')
  return { mode: requested === undefined ? 'full' : 'diagnostic-subset', caseIds: ids }
}

/** A completed diagnostic subset never establishes completion of the full paired experiment.
 * @param cases - retained case results.
 * @param selection - full or explicitly selected fixed cases.
 * @param repetitions - required paired repetitions per case.
 * @param stopped - whether the request budget prevented completion.
 * @returns separate full-experiment and diagnostic completion flags.
 */
export function experimentCompletion(cases, selection, repetitions, stopped) {
  const selectedComplete = !stopped && cases.length === selection.caseIds.length && new Set(cases.map(item => item.id)).size === cases.length
    && cases.every(item => selection.caseIds.includes(item.id) && item.repetitions.length === repetitions
      && new Set(item.repetitions.map(pair => pair.repetition)).size === repetitions
      && item.repetitions.every(pair => Number.isSafeInteger(pair.repetition) && pair.repetition >= 0 && pair.repetition < repetitions
        && pair.arms.length === 2 && pair.arms.some(arm => arm.arm === 'control') && pair.arms.some(arm => arm.arm === 'memory')
        && pair.arms.every(arm => arm.completed)))
  return { completed: selection.mode === 'full' && selection.caseIds.length === 12 && selectedComplete,
    diagnosticCompleted: selection.mode === 'diagnostic-subset' && selectedComplete }
}

/** Require every relevant case to avoid regression and at least one whole case to improve.
 * @param cases - complete case results, including frozen model and prompt settings.
 * @param definitions - twelve fixed case definitions with relevance labels.
 * @param completed - full paired-experiment completion, never diagnostic completion.
 * @returns acceptance and explicit uniformity, safety and per-case checks.
 */
export function experimentAcceptance(cases, definitions, completed) {
  const first = cases[0]
  const uniformModelSettings = first?.modelSettings !== undefined && cases.every(item => isDeepStrictEqual(item.modelSettings, first.modelSettings))
  const uniformPrompts = first?.promptVersions !== undefined && cases.every(item => isDeepStrictEqual(item.promptVersions, first.promptVersions))
  const relevant = cases.filter(item => definitions.find(definition => definition.id === item.id)?.relevant)
  const count = (item, name) => item.repetitions.flatMap(pair => pair.arms).filter(arm => arm.arm === name && arm.completed && arm.correct).length
  const regressedCases = relevant.filter(item => count(item, 'memory') < count(item, 'control')).map(item => item.id)
  const improvedCases = relevant.filter(item => count(item, 'memory') > count(item, 'control')).map(item => item.id)
  const hardCases = ['private-project', 'approved-shared', 'revoked-shared', 'contradictory-success', 'contradictory-zero']
  const hardCasesPassed = hardCases.every(id => {
    const item = cases.find(item => item.id === id)
    return item?.isolationPassed === true && item.wrongKnowledge === 0 && item.checkedKnowledge > 0 && item.learningFailures.length === 0
      && (!['approved-shared', 'revoked-shared'].includes(id) || item.approvedRef !== undefined)
  })
  return { passed: completed && uniformModelSettings && uniformPrompts && hardCasesPassed && regressedCases.length === 0 && improvedCases.length > 0,
    checks: { uniformModelSettings, uniformPrompts, hardCasesPassed, regressedCases, improvedCases } }
}

/** Exact synthetic project markers prevent pretrained knowledge from satisfying memory-dependent cases.
 * @param caseInput - fixed answer rubric and expected recall markers.
 * @param answer - model's JSON answer.
 * @param recallTexts - text actually supplied from retrieval.
 * @returns answer and recall assessments, or an explicit parse failure.
 */
export function grade(caseInput, answer, recallTexts) {
  let response
  try { response = JSON.parse(answer.replace(/^```(?:json)?\s*/u, '').replace(/\s*```$/u, '')) } catch { return { correct: false, parseFailure: true } }
  const text = String(response.answer ?? '').toLocaleLowerCase('en-US')
  const correct = caseInput.expectedVerified === undefined
    ? caseInput.required.every(token => text.includes(token.toLocaleLowerCase('en-US'))) && !(caseInput.forbidden ?? []).some(token => text.includes(token.toLocaleLowerCase('en-US')))
    : response.verified === caseInput.expectedVerified
  const relevant = recallTexts.filter(value => (caseInput.recallMarkers ?? caseInput.required).some(token => value.includes(token))).length
  return { correct, relevantRecall: relevant, recallCount: recallTexts.length,
    recallPrecision: recallTexts.length === 0 ? null : relevant / recallTexts.length,
    recallCovered: caseInput.relevant ? relevant > 0 : recallTexts.length === 0 }
}
