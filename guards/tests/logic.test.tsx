import { expect, test } from 'claude-code/testing'

import { advise, budget, decide, missOf, outcomeKey, withPrevious, needOf, parseFeatures, type Features } from '../hooks/model-logic'
import { SHARE, addToDay, healDays, foldSession, newSession, pace, todayVerdict, verdict, weekDelta, seedToday } from '../hooks/usage-logic'

const NOW = Date.parse('2026-10-28T12:00:00')
const H = 3_600_000
const D = 24 * H

const READINGS = [
  { kind: 'five_hour', percentUsed: 42, resetsAt: new Date(NOW + 2 * H).toISOString() },
  { kind: 'seven_day', percentUsed: 61, resetsAt: new Date(NOW + 48 * H).toISOString() },
]

const weekAt = (pct: number) => [
  { kind: 'five_hour', percentUsed: 12, resetsAt: new Date(NOW + 3 * H).toISOString() },
  { kind: 'seven_day', percentUsed: pct, resetsAt: new Date(NOW + 4 * D).toISOString() },
]
const CALM = weekAt(20)

const f = (over: Partial<Features>): Features => ({
  kind: 'edit',
  scope: 'small',
  ambiguity: 'low',
  risk: 'low',
  topic: 'related',
  deepReasoning: false,
  priorFailures: false,
  longRunning: false,
  why: 'x',
  ...over,
})

const pickFor = (over: Partial<Features>, extra: Partial<Parameters<typeof decide>[3]> = {}) =>
  decide(needOf(f(over)), 'x', 'haiku', { budget: budget(CALM, NOW), costs: {}, ...extra })

test('the day ledger and the session add up across readings and a reset', async () => {
  expect(weekDelta({ pct: 10, resetsAt: NOW + 48 * H }, { pct: 14, resetsAt: NOW + 48 * H })).toBe(4)
  expect(weekDelta({ pct: 14, resetsAt: NOW + 48 * H }, { pct: 2, resetsAt: NOW + 216 * H })).toBe(2)
  // A lower figure in the same week is another chat's older reading: nothing added, no false reset.
  expect(weekDelta({ pct: 25, resetsAt: NOW + 48 * H }, { pct: 23, resetsAt: NOW + 48 * H })).toBe(0)
  expect(addToDay(addToDay({}, NOW, 4), NOW, 2)['2026-10-28']?.used).toBe(6)

  let s = foldSession(newSession(NOW), READINGS)
  s = foldSession(s, [
    { kind: 'five_hour', percentUsed: 45.5, resetsAt: READINGS[0]!.resetsAt },
    { kind: 'seven_day', percentUsed: 61.4, resetsAt: READINGS[1]!.resetsAt },
  ])
  expect(s.five).toBe(3.5)
  expect(s.week).toBe(0.4)
})

test('the cheapest option that meets the need wins, and the top rungs need a reason', async () => {
  expect(pickFor({ kind: 'question' })).toMatchObject({ model: 'haiku' })
  expect(pickFor({ kind: 'feature', scope: 'medium' })).toMatchObject({ model: 'sonnet', effort: 'medium' })
  // Ordinary Opus work runs at medium; high needs deep reasoning or a vague goal.
  expect(pickFor({ kind: 'architecture', scope: 'medium' })).toMatchObject({ model: 'opus', effort: 'medium' })
  // A subtle bug is Opus at high; xhigh waits for work that runs past half an hour (RESEARCH 8).
  expect(pickFor({ kind: 'bugfix', ambiguity: 'high', deepReasoning: true })).toMatchObject({ model: 'opus', effort: 'high' })
  expect(pickFor({ kind: 'feature', scope: 'large', deepReasoning: true, longRunning: true })).toMatchObject({ model: 'opus', effort: 'xhigh' })
  // A large build is Opus, not Fable, until it is vague or has failed before.
  expect(pickFor({ kind: 'architecture', scope: 'large', ambiguity: 'medium', deepReasoning: true }).model).toBe('opus')
  // Fable waits for hours-long deep work, or deep work that already failed (RESEARCH 1-3).
  expect(pickFor({ kind: 'architecture', scope: 'large', ambiguity: 'high', deepReasoning: true }).model).toBe('opus')
  const fable = pickFor({ kind: 'architecture', scope: 'large', ambiguity: 'high', deepReasoning: true, longRunning: true })
  expect(fable.model).toBe('fable')
  expect(fable.notes.join(' ')).toMatch(/usage credits/)
  // A costly pick names a cheaper step below it.
  expect(fable.notes[0]).toMatch(/^Lighter option: (Fable|Opus) · \w+, about [\d.]+× less/)
  // Max needs deep reasoning, earlier failures and scale together.
  expect(pickFor({ kind: 'architecture', scope: 'large', deepReasoning: true, priorFailures: true }).effort).toBe('max')
})

test('a follow-up in a long conversation stays on the running model; a new topic says /clear', async () => {
  const dog = { kind: 'question', scope: 'tiny' } as const
  const onOpus = { actual: { model: 'claude-opus-5-5', effort: 'max' } }
  expect(pickFor(dog, { ...onOpus, context: 10_000 }).model).toBe('haiku')
  const stay = pickFor(dog, { ...onOpus, context: 120_000, topic: 'related' })
  expect(stay).toMatchObject({ model: 'opus', effort: 'low' })
  expect(stay.notes.join(' ')).toMatch(/re-read this chat’s 120k tokens/)
  expect(pickFor(dog, { ...onOpus, context: 120_000, topic: 'new' }).notes.join(' ')).toMatch(/\/clear/)
})

test('the budget steps down for a full 5-hour window or a day past its allowance, never for a weekly forecast', async () => {
  // A week heading to 92% at its pace so far is no reason: days off would prove it wrong.
  expect(budget(weekAt(80), NOW).steps).toBe(0)
  const five = [{ kind: 'five_hour', percentUsed: 90, resetsAt: new Date(NOW + H).toISOString() }]
  expect(budget(five, NOW)).toMatchObject({ steps: 1, why: '5-hour window 90%' })
  expect(budget(CALM, NOW, { isOver: true, isShort: false }).steps).toBe(1)
  const tight = budget(five, NOW, { isOver: true, isShort: false })
  expect(tight.steps).toBe(2)
  const hard = decide(needOf(f({ kind: 'bugfix', ambiguity: 'high', deepReasoning: true })), 'x', 'haiku', { budget: tight, costs: {} })
  expect(hard).toMatchObject({ model: 'opus', effort: 'low' })
  expect(hard.notes.join(' ')).toMatch(/save your limits: 5-hour window 90%, past today’s allowance/)
})

test('measured per-prompt costs never reorder the options; savings come from the research', async () => {
  // Short tests ran on Opus high, heavy work on Opus low: per prompt, high looks cheaper. It isn't.
  const costs = { 'opus·low': { turns: 5, week: 4 }, 'opus·high': { turns: 5, week: 0.5 } }
  const quick = decide(needOf(f({ kind: 'question', topic: 'related' })), 'x', 'haiku', {
    budget: budget(CALM, NOW),
    costs,
    actual: { model: 'claude-opus-5-5', effort: 'high' },
    context: 700_000,
  })
  expect(quick).toMatchObject({ model: 'opus', effort: 'low' })
  // Having stayed on Opus, no lighter option on another model.
  expect(quick.notes.join(' ')).not.toMatch(/Lighter option: Haiku/)
  const rec = pickFor({ kind: 'feature', risk: 'medium' })
  const a = advise(rec, { model: 'claude-opus-5-5', effort: 'max' }, costs)
  expect(a.text).toBe('Try Sonnet · high')
  expect(a.extra).toMatch(/Sonnet · high costs about 7× less than Opus · max/)
})

test('what the week used before counting began goes to today by its share of the window', async () => {
  // The week reset last night at 22:00; by noon 2% is used: 12 of those 14 hours are today's.
  const week = { pct: 2, resetsAt: NOW - 14 * H + 7 * D }
  expect(seedToday({}, week, NOW)['2026-10-28']?.used).toBe(1.7)
  // It never lowers what today already counted.
  expect(seedToday({ '2026-10-28': { used: 1.9 } }, week, NOW)['2026-10-28']?.used).toBe(1.9)
})

test('a model and effort measured at 0% counts as unknown, never as free', async () => {
  const costs = { 'opus·low': { turns: 4, week: 0 }, 'opus·medium': { turns: 4, week: 1.2 } }
  const rec = pickFor({ kind: 'question' }, { actual: { model: 'claude-opus-5-5', effort: 'medium' }, context: 120_000, costs })
  const a = advise(rec, { model: 'claude-opus-5-5', effort: 'medium' }, costs)
  expect(a.extra).not.toMatch(/Infinity|NaN/)
})

test('your own misses raise the advice: a wrong answer the model, cut corners the effort', async () => {
  expect(missOf('it still doesn\'t work')).toBe('wrong')
  expect(missOf('עדיין לא עובד')).toBe('wrong')
  expect(missOf('you skipped the tests')).toBe('shallow')
  expect(missOf('looks good, thanks')).toBe(undefined)

  const need = needOf(f({ kind: 'feature', scope: 'medium' }))
  const calm = { budget: budget(CALM, NOW), costs: {}, kind: 'feature' }
  expect(decide(need, 'x', 'haiku', calm)).toMatchObject({ model: 'sonnet', effort: 'medium' })
  const wrong = { [outcomeKey('feature', 'sonnet', 'medium')]: { turns: 4, wrong: 2, shallow: 0 } }
  const raised = decide(need, 'x', 'haiku', { ...calm, outcomes: wrong })
  expect(raised.model).toBe('opus')
  expect(raised.notes.join(' ')).toMatch(/missed on 2 of 4 similar tasks/)
  const shallow = { [outcomeKey('feature', 'sonnet', 'medium')]: { turns: 4, wrong: 0, shallow: 2 } }
  expect(decide(need, 'x', 'haiku', { ...calm, outcomes: shallow })).toMatchObject({ model: 'sonnet', effort: 'high' })
})

test('before any turn the effort is unknown, so the same model is not called a mismatch', async () => {
  const rec = pickFor({ kind: 'question' }, { actual: { model: 'claude-opus-5-5' }, context: 120_000 })
  const a = advise(rec, { model: 'claude-opus-5-5' }, {})
  expect(a.text).toBe('Opus · low')
  expect(a.extra).not.toMatch(/set \/effort/)
})


test('today carries what earlier days left or overdrew, and red means the days ahead are squeezed', async () => {
  // Wednesday noon; the week reset Sunday noon and resets in 4 days. By midnight tonight an even
  // week is at 50%; by this morning it was at 35.7%.
  const week = { pct: 30, resetsAt: NOW + 4 * D }
  const p = pace(week, 10, NOW)!
  expect(Math.round(p.expected * 10) / 10).toBe(42.9)
  // 20% before today against 35.7% even: +15.7% carried, so today has 50 - 20 = 30%.
  expect(Math.round(p.carry * 10) / 10).toBe(15.7)
  expect(Math.round(p.todayBudget * 10) / 10).toBe(30)
  // The tick: where today would be by now on an even pace, 42.9 - 20.
  expect(Math.round(p.todayUsual * 10) / 10).toBe(22.9)
  expect(p.restDaily).toBe(17.5)
  expect(todayVerdict({ week, todayUsed: 10, pace: p }).word).toBe('on track')

  // Heavy earlier days: 37% before today overdrew 1.3%, leaving today 13%; using 15% is past it, and fine.
  const heavy = { pct: 52, resetsAt: NOW + 4 * D }
  const h = pace(heavy, 15, NOW)!
  expect(Math.round(h.carry * 10) / 10).toBe(-1.3)
  expect(Math.round(h.todayBudget * 10) / 10).toBe(13)
  const over = todayVerdict({ week: heavy, todayUsed: 15, pace: h })
  expect(over.tone).toBe('warning')
  expect(over.extra).toMatch(/fine/)

  // 85% used with 4 days left: under half an even day each. That's the red flag.
  const short = { pct: 85, resetsAt: NOW + 4 * D }
  expect(todayVerdict({ week: short, todayUsed: 10, pace: pace(short, 10, NOW) }).tone).toBe('error')
  expect(SHARE).toBeGreaterThan(14.2)
})

test('a check-in after heavy work is a question, not that work again', async () => {
  const heavy = { tier: 3, depth: 2 }
  const checkIn = f({ kind: 'question', scope: 'tiny', topic: 'continues' })
  expect(withPrevious(needOf(checkIn), checkIn, heavy)).toEqual({ tier: 1, depth: 0 })
  const goAhead = f({ kind: 'refactor', topic: 'continues' })
  expect(withPrevious(needOf(goAhead), goAhead, heavy).depth).toBe(2)
  // A one-spot bug fix is everyday work, at medium.
  expect(needOf(f({ kind: 'bugfix', scope: 'tiny' })).depth).toBe(1)
})

test('on the running model, a known effort is compared; an unknown one is only named', async () => {
  const rec = pickFor({ kind: 'question' }, { actual: { model: 'claude-opus-5-5' }, context: 120_000 })
  expect(advise(rec, { model: 'claude-opus-5-5', effort: 'low' }).text).toBe('Opus · low ✓ fits')
  const off = advise(rec, { model: 'claude-opus-5-5', effort: 'high' })
  expect(off.text).toBe('Set effort to low')
  expect(off.extra).toMatch(/you're on high/)
  expect(advise(rec, { model: 'claude-opus-5-5' }).text).toBe('Opus · low')
})

test('the days of a week never add up to more than the week; today gives back the excess', async () => {
  const week = { pct: 29, resetsAt: NOW + 4 * 24 * H + 10 * H }
  const days = { '2026-10-24': { used: 9 }, '2026-10-27': { used: 12.8 }, '2026-10-28': { used: 32 } }
  // The 24th is before this week began; the 27th and today count: 12.8 + 32 = 44.8 against 29.
  expect(healDays(days, week, NOW)['2026-10-28']?.used).toBe(16.2)
  expect(healDays({ '2026-10-28': { used: 5 } }, week, NOW)['2026-10-28']?.used).toBe(5)
})
