/** Live-experiment accounting rejects the next request before any provider dispatch. */
import { expect, it } from 'vitest'
// The runner is plain JavaScript so the supported built profile needs no source loader.
// @ts-expect-error The owner-local diagnostic intentionally has no published declarations.
import { ExperimentBudget, grade, selectFixedCases, experimentCompletion, experimentAcceptance } from '../evaluation/quality-runner.mjs'

it('reserves unknown-usage calls and refuses the next call at the budget', async () => {
  const budget = new ExperimentBudget({ calls: 1, inputTokens: 10000, outputTokens: 10 })
  let dispatched = 0
  const adapter = budget.wrap({ async *stream() { dispatched++; yield { type: 'finish' } } }, 'answer')
  const request = { system: 'test', messages: [], maxTokens: 10 }
  for await (const _chunk of adapter.stream(request)) { /* Consume the complete provider stream. */ }
  await expect(async () => { for await (const _chunk of adapter.stream(request)) { /* A second dispatch must be refused. */ } }).rejects.toThrow('EXPERIMENT_BUDGET_EXHAUSTED')
  expect(dispatched).toBe(1)
  expect(budget.report()).toMatchObject({ requests: 1, unknownUsageCalls: 1, cost: 'unknown', stopped: true })
})

it('requires the private marker and separates answer quality from recall coverage', () => {
  const item = { required: ['ESM', 'route731'], relevant: true }
  expect(grade(item, '{"answer":"ESM"}', ['route731'])).toMatchObject({ correct: false, recallCovered: true })
  expect(grade(item, '{"answer":"ESM route731"}', [])).toMatchObject({ correct: true, recallCovered: false })
  expect(grade({ required: ['potato'], relevant: false }, '{"answer":"Potatoes and butter"}', [])).toMatchObject({ correct: true })
})

it.each([
  { inputTokens: 1, outputTokens: 100, maxTokens: 1 },
  { inputTokens: 10000, outputTokens: 1, maxTokens: 2 },
])('rejects input or output reservation overflow before dispatch', async limits => {
  const budget = new ExperimentBudget({ calls: 10, inputTokens: limits.inputTokens, outputTokens: limits.outputTokens })
  let dispatched = 0
  const adapter = budget.wrap({ async *stream() { dispatched++; yield { type: 'finish' } } }, 'learning')
  await expect(async () => { for await (const _chunk of adapter.stream({ messages: [], maxTokens: limits.maxTokens })) { /* Budget rejection precedes dispatch. */ } }).rejects.toThrow('EXPERIMENT_BUDGET_EXHAUSTED')
  expect(dispatched).toBe(0)
})

it('preserves provider terminal failure and counts disjoint cached input', async () => {
  const budget = new ExperimentBudget()
  const adapter = budget.wrap({ async *stream() {
    yield { type: 'usage', usage: { inputTokens: 3, cacheReadTokens: 4, cacheWriteTokens: 5, outputTokens: 2 } }
    yield { type: 'finish', reason: { kind: 'error' } }
  } }, 'answer')
  for await (const _chunk of adapter.stream({ messages: [], maxTokens: 10 })) { /* Capture the settled provider stream. */ }
  expect(budget.report()).toMatchObject({ inputTokens: 12, outputTokens: 2, unknownUsageCalls: 0, calls: [{ outcome: 'error' }] })
})

it('charges earlier failed runs once before reserving another dispatch', () => {
  const budget = new ExperimentBudget({ calls: 2, inputTokens: 10000, outputTokens: 10 })
  budget.importPrior({ budget: { calls: [
    { phase: 'learning', reservedInput: 100, reservedOutput: 5, usage: null },
    { phase: 'learning', reservedInput: 100, reservedOutput: 5, usage: null, priorReport: 'another-report' },
  ] } }, 'prior-report')
  budget.reserve({ messages: [], maxTokens: 5 }, 'answer')
  expect(() => budget.reserve({ messages: [], maxTokens: 1 }, 'answer')).toThrow('EXPERIMENT_BUDGET_EXHAUSTED')
  expect(budget.report()).toMatchObject({ requests: 2, currentRunRequests: 1, unknownUsageCalls: 2 })
})

it('releases unused reservations after complete usage and retains unknown attempts', async () => {
  const budget = new ExperimentBudget({ calls: 3, inputTokens: 10000, outputTokens: 12 })
  const known = budget.wrap({ async *stream() {
    yield { type: 'usage', usage: { inputTokens: 2, outputTokens: 2 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  } }, 'answer')
  for await (const _chunk of known.stream({ messages: [], maxTokens: 10 })) { /* Settlement releases eight unused output tokens. */ }
  budget.reserve({ messages: [], maxTokens: 10 }, 'unknown')
  expect(budget.report()).toMatchObject({ reservedOutputTokens: 12 })
  expect(() => budget.reserve({ messages: [], maxTokens: 1 }, 'answer')).toThrow('EXPERIMENT_BUDGET_EXHAUSTED')
})

it('limits diagnostic subsets to fixed IDs and never labels a subset as full completion', () => {
  const cases = Array.from({ length: 12 }, (_, index) => ({ id: `case-${index}` }))
  expect(() => selectFixedCases(cases, 'invented-case')).toThrow('twelve fixed cases')
  expect(() => selectFixedCases(cases, 'case-1,case-1')).toThrow('unique IDs')
  const selection = selectFixedCases(cases, 'case-1,case-2')
  const results = selection.caseIds.map((id: string) => ({ id, repetitions: Array.from({ length: 3 }, (_, repetition) => ({ repetition,
    arms: [{ arm: 'control', completed: true }, { arm: 'memory', completed: true }] })) }))
  expect(experimentCompletion(results, selection, 3, false)).toEqual({ completed: false, diagnosticCompleted: true })
  expect(experimentCompletion(results, selection, 3, true)).toEqual({ completed: false, diagnosticCompleted: false })
})

function acceptedExperiment() {
  const names = ['private-project', 'approved-shared', 'revoked-shared', 'contradictory-success', 'contradictory-zero',
    'project-constraints', 'negative-result', 'updated-decision', 'unrelated', 'l1-only', 'l2-only', 'multi-session-distractor']
  const definitions = names.map(id => ({ id, relevant: id === 'project-constraints' || id === 'l1-only' }))
  const cases = definitions.map(item => ({ id: item.id, isolationPassed: true, wrongKnowledge: 0, checkedKnowledge: 1, learningFailures: [],
    approvedRef: { id: 'fixed-version', revision: 1 }, modelSettings: { thinking: 'disabled', reasoningEffort: 'off' },
    promptVersions: { l1: 'l1-v4', knowledge: 'knowledge-v5' }, repetitions: Array.from({ length: 3 }, (_, repetition) => ({ repetition,
      arms: [{ arm: 'control', completed: true, correct: !item.relevant }, { arm: 'memory', completed: true, correct: true }] })) }))
  return { cases, definitions, selection: selectFixedCases(definitions) }
}

it('rejects duplicate cases, repetition numbers and answer arms before full completion', () => {
  const { cases, selection } = acceptedExperiment()
  expect(experimentCompletion(cases, selection, 3, false).completed).toBe(true)
  expect(experimentCompletion([...cases.slice(0, -1), cases[0]], selection, 3, false).completed).toBe(false)
  cases[0]!.repetitions[1]!.repetition = 0
  expect(experimentCompletion(cases, selection, 3, false).completed).toBe(false)
  cases[0]!.repetitions[1]!.repetition = 1
  cases[0]!.repetitions[0]!.arms[1]!.arm = 'control'
  expect(experimentCompletion(cases, selection, 3, false).completed).toBe(false)
})

it('rejects a per-case regression even when other relevant cases improve the aggregate', () => {
  const { cases, definitions } = acceptedExperiment()
  expect(experimentAcceptance(cases, definitions, true).passed).toBe(true)
  const regressed = cases.find(item => item.id === 'l1-only')!
  regressed.repetitions[0]!.arms[0]!.correct = true
  for (const pair of regressed.repetitions) pair.arms[1]!.correct = false
  expect(experimentAcceptance(cases, definitions, true)).toMatchObject({ passed: false, checks: { regressedCases: ['l1-only'] } })
})

it('requires a whole relevant case improvement rather than one favorable pair within a tie', () => {
  const { cases, definitions } = acceptedExperiment()
  for (const item of cases) for (const pair of item.repetitions) pair.arms[0]!.correct = true
  const tied = cases.find(item => item.id === 'project-constraints')!
  tied.repetitions[0]!.arms[0]!.correct = false
  tied.repetitions[1]!.arms[1]!.correct = false
  expect(experimentAcceptance(cases, definitions, true)).toMatchObject({ passed: false, checks: { improvedCases: [] } })
})

it('rejects mixed model settings, mixed prompt versions and missing hard-case verification', () => {
  const { cases, definitions } = acceptedExperiment()
  cases[0]!.modelSettings.reasoningEffort = 'high'
  expect(experimentAcceptance(cases, definitions, true)).toMatchObject({ passed: false, checks: { uniformModelSettings: false } })
  cases[0]!.modelSettings.reasoningEffort = 'off'
  cases[0]!.promptVersions.l1 = 'l1-v3'
  expect(experimentAcceptance(cases, definitions, true)).toMatchObject({ passed: false, checks: { uniformPrompts: false } })
  cases[0]!.promptVersions.l1 = 'l1-v4'
  cases[0]!.isolationPassed = false
  expect(experimentAcceptance(cases, definitions, true)).toMatchObject({ passed: false, checks: { hardCasesPassed: false } })
  cases[0]!.isolationPassed = true
  expect(experimentAcceptance(cases, definitions, false).passed).toBe(false)
})

it('keeps the remaining 21-request limit for a diagnostic after 219 historical attempts', () => {
  const budget = new ExperimentBudget()
  budget.importPrior({ budget: { calls: Array.from({ length: 219 }, () => ({ phase: 'learning', reservedInput: 1, reservedOutput: 1, usage: null })) } }, 'full-experiment')
  for (let index = 0; index < 21; index++) budget.reserve({ messages: [], maxTokens: 1 }, 'diagnostic')
  expect(() => budget.reserve({ messages: [], maxTokens: 1 }, 'diagnostic')).toThrow('EXPERIMENT_BUDGET_EXHAUSTED')
  expect(budget.report()).toMatchObject({ requests: 240, currentRunRequests: 21, stopped: true })
})

it('applies an authorized 360-request cap cumulatively without resetting the 237 historical attempts', () => {
  const budget = new ExperimentBudget({ calls: 360, inputTokens: 2000000, outputTokens: 250000 })
  budget.importPrior({ budget: { calls: Array.from({ length: 237 }, () => ({ phase: 'learning', reservedInput: 1, reservedOutput: 1, usage: null })) } }, 'earlier-experiment')
  for (let index = 0; index < 123; index++) budget.reserve({ messages: [], maxTokens: 1 }, 'answer')
  expect(() => budget.reserve({ messages: [], maxTokens: 1 }, 'answer')).toThrow('EXPERIMENT_BUDGET_EXHAUSTED')
  expect(budget.report()).toMatchObject({ requests: 360, currentRunRequests: 123, stopped: true })
})
