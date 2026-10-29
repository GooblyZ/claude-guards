import { atom, read, update } from 'claude-code'
import type { Args, EngineInterface, Register, Timer } from 'claude-code'

import type { Actual, Cost, GuardRow, Need, Rec, Spent } from '../types'
import {
  SYSTEM,
  advise,
  budget,
  buildAsk,
  costKey,
  decide,
  difficulty,
  missOf,
  isFollowUp,
  label,
  needFromRules,
  needOf,
  parseFeatures,
  perPrompt,
  tierName,
  withPrevious,
  type Features,
  type Outcome,
  type Reading,
  type Turn,
} from './model-logic'

export const draftAtom = atom({ plugin: 'guards', key: 'draft' } as const, null, { shape: 'rec-4' })
export const lastAtom = atom({ plugin: 'guards', key: 'last' } as const, null, { shape: 'rec-4' })
export const actualAtom = atom({ plugin: 'guards', key: 'actual' } as const, null, { shape: 'actual-1' })
const enabledAtom = atom({ plugin: 'guards', key: 'isEnabled' } as const, true)
// The usage side's meter, read here for today's state: the same value, declared again in this file.
const meterAtom = atom({ plugin: 'guards', key: 'meter' } as const, null, { shape: 'meter-3' })
export const modelOnAtom = atom({ plugin: 'guards', key: 'modelOn' } as const, true)
export const smartAtom = atom({ plugin: 'guards', key: 'isSmart' } as const, true)
export const checkingAtom = atom({ plugin: 'guards', key: 'isChecking' } as const, false)

/** How long typing must pause before the Sonnet check runs. */
const PAUSE_MS = 1200
/** Drafts shorter than this get the local rules alone. */
const MIN_SMART = 20

// Module memory; a reload starts it over, what is drawn lives in $.state.
const mem: {
  readings: Reading[]
  context?: number
  draftText: string
  previousNeed?: Need
  timer?: Timer
  stop?: AbortController
  checked: Map<string, Rec>
  turn?: { key: string; week?: number }
  /** The kind of the prompt last sent, and the last main turn it ran as, for the outcome ledger. */
  sentKind?: string
  lastTurn?: { kind: string; key: string }
  /** The desktop app's state file for this session once found, when it was last looked for, and what it last said. */
  stateFile?: string
  stateLookedAt?: number
  stateRead?: { mtimeMs: number; model?: string; effort?: string }
  /** The timer that watches the state file for a change in the menu. */
  poll?: Timer
  /** A main-loop turn is running: the Sonnet check waits behind it, so it waits for the turn's end. */
  isTurnRunning?: boolean
  /** The conversation as of the last turn's end: the check's context while a turn runs. */
  convo?: { first?: string; recent: Turn[] }
} = { readings: [], draftText: '', checked: new Map() }

export async function getCosts($: EngineInterface) {
  return ((await $.store.get('costs')) ?? {}) as Record<string, Cost>
}
const weekOf = (list: Reading[]) => list.find(r => r.kind === 'seven_day')?.percentUsed

async function todayState($: EngineInterface) {
  const m = await read($, meterAtom)
  if (!m?.pace) return undefined
  return { isOver: m.todayUsed > m.pace.todayBudget, isShort: m.pace.restDaily !== undefined && m.pace.restDaily < 100 / 7 / 2 }
}

async function getOutcomes($: EngineInterface) {
  return ((await $.store.get('outcomes')) ?? {}) as Record<string, Outcome>
}

// What the decision weighs besides the need: budget, your costs and outcomes, the running model, the context.
async function contextFor($: EngineInterface, kind: string, topic?: Features['topic']) {
  return {
    budget: budget(mem.readings, await $.clock.now(), await todayState($)),
    costs: await getCosts($),
    actual: (await read($, actualAtom)) ?? undefined,
    context: mem.context,
    topic,
    kind,
    outcomes: await getOutcomes($),
  }
}

async function localAdvice($: EngineInterface, text: string): Promise<Rec> {
  const known = mem.checked.get(text.trim())
  if (known) return known
  const d = difficulty(text)
  return decide(needFromRules(d, mem.previousNeed), d.reasons.join(' · ') || 'routine task', 'local', await contextFor($, 'local'))
}

const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max']

/**
 * The Claude desktop app keeps a state file per session that holds the model and effort picked
 * in its menu, written as they change. Claude Code itself tells a mod neither until a turn runs
 * at them, so this file is where a change shows first. Found once per session by its id among
 * the most recently written files; on any other host there is none and the turns' report stands.
 */
async function findStateFile($: EngineInterface) {
  if (mem.stateFile) return mem.stateFile
  // A new chat's file can appear after the chat starts: not found, look again 15 seconds on.
  const now = await $.clock.now()
  if (mem.stateLookedAt !== undefined && now - mem.stateLookedAt < 15_000) return undefined
  mem.stateLookedAt = now
  try {
    const local = await $.env.get('LOCALAPPDATA')
    if (!local) return undefined
    const id = await $.session.id()
    const root = `${local}\\Claude-Data`
    const files: { path: string; mtimeMs: number }[] = []
    for (const pkg of await $.fs.list(root)) {
      const sessions = `${root}\\${pkg.name}\\claude-code-sessions`
      if (pkg.kind !== 'dir' || !(await $.fs.exists(sessions))) continue
      for (const a of await $.fs.list(sessions)) {
        if (a.kind !== 'dir') continue
        for (const b of await $.fs.list(`${sessions}\\${a.name}`)) {
          if (b.kind !== 'dir') continue
          const dir = `${sessions}\\${a.name}\\${b.name}`
          for (const f of await $.fs.list(dir)) if (f.kind === 'file' && f.name.endsWith('.json')) files.push({ path: `${dir}\\${f.name}`, mtimeMs: f.mtimeMs })
        }
      }
    }
    for (const f of files.sort((x, y) => y.mtimeMs - x.mtimeMs).slice(0, 12)) {
      if (String(await $.fs.read(f.path)).includes(id)) return (mem.stateFile = f.path)
    }
  } catch {
    // No desktop app here, or its files moved: the turns' report stands.
  }
  return undefined
}

// The model and effort as set now: the desktop app's state file when there is one, re-read only
// when it changed; else what the last turn ran at.
async function refreshModel($: EngineInterface) {
  let model = await $.session.model()
  let effort: string | undefined
  const path = await findStateFile($)
  if (path) {
    try {
      const { mtimeMs } = await $.fs.stat(path)
      if (mem.stateRead?.mtimeMs !== mtimeMs) {
        const d = JSON.parse(String(await $.fs.read(path))) as { model?: unknown; effort?: unknown }
        mem.stateRead = {
          mtimeMs,
          model: typeof d.model === 'string' ? d.model : undefined,
          effort: typeof d.effort === 'string' && LEVELS.includes(d.effort) ? d.effort : undefined,
        }
      }
      model = mem.stateRead.model ?? model
      effort = mem.stateRead.effort
    } catch {
      mem.stateRead = undefined
    }
  }
  await update($, actualAtom, a => ({ model, effort: effort ?? a?.effort }))
}

const cancelCheck = () => {
  mem.timer?.cancel()
  mem.timer = undefined
  mem.stop?.abort()
  mem.stop = undefined
}

// One short Sonnet call that describes the draft; the policy decides from that.
async function smartCheck($: EngineInterface, text: string) {
  if (mem.draftText !== text || !(await read($, enabledAtom)) || !(await read($, modelOnAtom)) || !(await read($, smartAtom))) return
  const stop = new AbortController()
  mem.stop = stop
  await update($, checkingAtom, () => true)
  // While a turn runs, the call can wait without end: give up after 8 seconds and keep the local estimate.
  const giveUp = $.clock.after(8000, () => {
    stop.abort()
    void update($, checkingAtom, () => false)
  })
  try {
    // While a turn runs the engine holds the transcript back until it ends: use the copy
    // taken when the last turn ended instead.
    const { first, recent } = mem.isTurnRunning && mem.convo ? mem.convo : await readConvo($)
    // Sonnet reads every draft: a misread sends a whole turn to the wrong model, and one Opus
    // task costs dozens of Sonnet reads [6][10]. Low effort: it describes, it doesn't solve.
    const r = await $.model.complete(
      { model: 'sonnet', system: [{ text: SYSTEM, cache: true }], prompt: buildAsk(text, first, recent), maxTokens: 160, effort: 'low', timeoutMs: 8000 },
      { signal: stop.signal },
    )
    const spent = ((await $.store.get('spent')) ?? { calls: 0, input: 0, output: 0 }) as Spent
    await $.store.set('spent', {
      calls: spent.calls + 1,
      input: spent.input + r.usage.input_tokens + r.usage.cache_creation_input_tokens + r.usage.cache_read_input_tokens,
      output: spent.output + r.usage.output_tokens,
    })
    const features = r.isAnswered ? parseFeatures(r.text) : undefined
    if (!features) return
    const need = withPrevious(needOf(features), features, mem.previousNeed)
    const decided = decide(need, features.why || features.kind, 'haiku', await contextFor($, features.kind, features.topic))
    // A draft the reader can't make out gets no advice rather than a guess.
    const rec: Rec = features.kind === 'unclear' ? { ...decided, isUnclear: true } : decided
    if (mem.checked.size > 50) mem.checked.delete(mem.checked.keys().next().value!)
    mem.checked.set(text.trim(), rec)
    if (mem.draftText === text) await update($, draftAtom, () => rec)
  } finally {
    giveUp.cancel()
    if (mem.stop === stop) mem.stop = undefined
    await update($, checkingAtom, () => false)
  }
}

async function readConvo($: EngineInterface) {
  const messages = (await $.session.messages()).filter(m => m.text.trim())
  mem.convo = { first: messages.find(m => m.role === 'user')?.text, recent: messages.slice(-4).map(m => ({ role: m.role, text: m.text })) }
  return mem.convo
}

// Score the draft locally now; schedule the Sonnet check for when typing pauses.
async function onDraft($: EngineInterface, text: string) {
  const wasEmpty = mem.draftText.trim() === ''
  mem.draftText = text
  cancelCheck()
  if (!(await read($, enabledAtom)) || !(await read($, modelOnAtom))) return
  if (text.trim() && (wasEmpty || !mem.timer)) await refreshModel($)
  if (text.trim().length < 8 || text.startsWith('/')) {
    await update($, draftAtom, () => null)
    return
  }
  const rec = await localAdvice($, text)
  await update($, draftAtom, () => rec)
  if (rec.source === 'local' && text.trim().length >= MIN_SMART && !isFollowUp(text) && (await read($, smartAtom)) && !mem.isTurnRunning) {
    mem.timer = $.clock.after(PAUSE_MS, () => {
      void smartCheck($, text).catch(() => undefined)
    })
  }
}

export async function setModelOn($: EngineInterface, isOn: boolean) {
  if (!isOn) cancelCheck()
  await update($, modelOnAtom, () => isOn)
  await $.store.set('modelOn', isOn)
  if (!isOn) await update($, draftAtom, () => null)
  else if (mem.draftText.trim()) await onDraft($, mem.draftText)
}

/** Part of the shared `session.start` hook. */
export async function modelStart($: EngineInterface, e: Args<'session.start'>) {
  await $.command.register({
    name: 'model-guard',
    description: 'Model advice: on, off, smart (adds a short Sonnet check) or local (rules only, no tokens)',
    argumentHint: '[on|off|smart|local]',
  })
  if ((await $.store.get('modelOn')) === false) await update($, modelOnAtom, () => false)
  if ((await $.store.get('isSmart')) === false) await update($, smartAtom, () => false)
  await refreshModel($)
  const usage = await $.session.usage()
  mem.readings = usage.rateLimits
  mem.context = usage.context.tokens
  void readConvo($).catch(() => undefined)
  // A switch in the desktop menu writes the state file: look every half second, so the row follows
  // it without a keystroke. A look is one stat; the file is read only when it changed.
  mem.poll?.cancel()
  mem.poll = $.clock.every(500, () => {
    void watchState($).catch(() => undefined)
  })
}

async function watchState($: EngineInterface) {
  // The engine knows a model switch at once; the desktop's file knows an effort switch.
  const model = await $.session.model()
  if (model !== (await read($, actualAtom))?.model && !mem.stateRead?.model) return refreshModel($)
  const path = await findStateFile($)
  if (!path) return
  const { mtimeMs } = await $.fs.stat(path)
  if (mem.stateRead?.mtimeMs !== mtimeMs) await refreshModel($)
}

/** Part of the shared `session.measure` hook. */
export async function modelMeasure($: EngineInterface, e: Args<'session.measure'>) {
  if (e.rateLimits.length) mem.readings = e.rateLimits
  if (e.context.tokens !== undefined) mem.context = e.context.tokens
}

/**
 * Part of the shared `turn.complete` hook: what the turn took from the weekly
 * limit, recorded under its model and effort whether or not the advice is shown.
 */
export async function modelTurnDone($: EngineInterface, e: Args<'turn.complete'>) {
  // The turn is over: a draft typed while it ran gets its full check now.
  if (e.agentId === undefined && mem.isTurnRunning) {
    mem.isTurnRunning = false
    // The full check for a draft typed while the turn ran: the model was busy until now.
    void readConvo($)
      .then(() => (mem.draftText.trim() ? onDraft($, mem.draftText) : undefined))
      .catch(() => undefined)
  }
  const turn = mem.turn
  if (e.agentId === undefined && turn) {
    mem.turn = undefined
    const usage = await $.session.usage()
    mem.readings = usage.rateLimits
    const week = weekOf(usage.rateLimits)
    if (turn.week !== undefined && week !== undefined && week >= turn.week) {
      const costs = await getCosts($)
      const c = costs[turn.key] ?? { turns: 0, week: 0 }
      await $.store.set('costs', { ...costs, [turn.key]: { turns: c.turns + 1, week: Math.round((c.week + week - turn.week) * 10) / 10 } })
    }
    // One more turn of this kind on this option; the next prompt says whether it missed.
    const kind = mem.sentKind ?? 'local'
    const outcomes = await getOutcomes($)
    const o = outcomes[`${kind}|${turn.key}`] ?? { turns: 0, wrong: 0, shallow: 0 }
    await $.store.set('outcomes', { ...outcomes, [`${kind}|${turn.key}`]: { ...o, turns: o.turns + 1 } })
    mem.lastTurn = { kind, key: turn.key }
  }
}

/** What the model row says in the block. */
export async function modelRow($: EngineInterface): Promise<GuardRow> {
  const isOn = await read($, modelOnAtom)
  const row = { name: 'Model', isOn, flip: () => setModelOn($, !isOn), text: '', note: '', extra: '', brief: '' }
  if (!isOn) return { ...row, note: 'off' }
  const draft = await read($, draftAtom)
  const rec = draft ?? (await read($, lastAtom))
  const isBusy = Boolean(draft) && (await read($, checkingAtom))
  // While Claude works, the session's model is busy and the check can't run: say so plainly,
  // with no advice that would only be a guess. It runs as soon as the turn ends.
  if (mem.isTurnRunning) return { ...row, note: '⏸ paused while Claude works · checks your draft when it’s done' }
  // While the check runs, the pulse stands where the advice goes, alone.
  if (isBusy) return { ...row, note: 'checking', isBusy }
  if (!rec) return { ...row, note: 'advice shows as you type' }
  if (rec.isUnclear) return { ...row, note: 'can’t tell what this asks yet' }
  const a = advise(rec, await read($, actualAtom), await getCosts($))
  const tone = a.tone === 'lighter' ? 'claude' : a.tone === 'heavier' ? 'warning' : a.tone === 'effort' ? 'suggestion' : 'success'
  // Advice for the prompt already sent says so, so it's never read as advice for the draft.
  const note = `${rec.source === 'haiku' ? '✦ ' : ''}${a.note}${draft ? '' : ' · last prompt'}`
  return { ...row, text: a.text, tone, note, extra: draft ? a.extra : '', brief: a.text }
}

export function registerModel(on: Parameters<Register>[0]) {
  // Live advice while typing, before anything is sent.
  on('prompt.edit', async ($, e, next) => {
    const box = await next(e)
    await onDraft($, box.text)
    return box
  })

  on('prompt.change', async ($, e, next) => {
    const done = await next(e)
    await onDraft($, e.text)
    return done
  })

  on('prompt.submit', async ($, e, next) => {
    if (!e.command && !e.isMeta && (await read($, modelOnAtom))) {
      cancelCheck()
      // "Still broken" or "you skipped the tests" after a turn counts against the option that ran it.
      const miss = missOf(e.text)
      if (miss && mem.lastTurn) {
        const key = `${mem.lastTurn.kind}|${mem.lastTurn.key}`
        const outcomes = await getOutcomes($)
        const o = outcomes[key] ?? { turns: 1, wrong: 0, shallow: 0 }
        await $.store.set('outcomes', { ...outcomes, [key]: { ...o, [miss]: o[miss] + 1 } })
        mem.lastTurn = undefined
      }
      const rec = await localAdvice($, e.text)
      mem.sentKind = rec.kind ?? 'local'
      mem.previousNeed = rec.need
      await update($, lastAtom, () => rec)
      await update($, draftAtom, () => null)
      mem.draftText = ''
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // The first request of a main-loop turn says which model and effort really ran.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined && e.index === 0) {
      mem.isTurnRunning = true
      // The desktop's own record of the effort wins over the one the turn reports, which is the
      // effort the session was launched with.
      const effort = mem.stateRead?.effort ?? e.effort
      const actual: Actual = { model: e.model, effort }
      await update($, actualAtom, () => actual)
      mem.turn = { key: costKey(e.model, effort), week: weekOf((await $.session.usage()).rateLimits) }
    }
    return yield* next(e)
  })

  // /effort typed in the prompt says the new level before any turn runs at it.
  on('command.run', { command: 'effort' }, async ($, e, next) => {
    const level = e.args.trim().toLowerCase()
    if (['low', 'medium', 'high', 'xhigh', 'max'].includes(level)) await update($, actualAtom, a => (a ? { ...a, effort: level } : a))
    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'model-guard' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'on' || arg === 'off') {
      await setModelOn($, arg === 'on')
      return { text: `model-guard: ${arg}` }
    }
    if (arg === 'smart' || arg === 'local') {
      const isSmart = arg === 'smart'
      if (!isSmart) cancelCheck()
      await update($, smartAtom, () => isSmart)
      await $.store.set('isSmart', isSmart)
      return {
        text: isSmart
          ? 'model-guard: smart. Local rules while you type, and a short Sonnet check once you pause.'
          : 'model-guard: local. Rules only, no tokens.',
      }
    }
    return { text: await report($) }
  })
}

async function report($: EngineInterface) {
  const isOn = await read($, modelOnAtom)
  const isSmart = await read($, smartAtom)
  const last = await read($, lastAtom)
  const spent = ((await $.store.get('spent')) ?? { calls: 0, input: 0, output: 0 }) as Spent
  const costs = await getCosts($)
  const lines = [`Model guard: ${isOn ? 'on' : 'off'}, ${isSmart ? 'smart (rules + a Sonnet description of the task)' : 'local (rules only, no tokens)'}`]
  if (last) {
    const depth = ['low', 'medium', 'high', 'xhigh', 'max'][last.need.depth]
    lines.push('', `Last advice: ${label(last.model, last.effort)} (${last.source === 'haiku' ? 'Sonnet-described' : 'local rules'})`)
    lines.push(`  needed: ${tierName(last.need.tier)}-class model, ${depth} effort, or a stronger model one step lower`)
    lines.push(`  why: ${last.why}`)
    for (const n of last.notes) lines.push(`  ${n}`)
  }
  const keys = Object.keys(costs).sort((a, b) => (perPrompt(costs, b) ?? 0) - (perPrompt(costs, a) ?? 0))
  lines.push('', 'Your measured cost per prompt (share of the weekly limit):')
  if (!keys.length) lines.push('  nothing measured yet: each turn adds to it, on or off')
  for (const k of keys) {
    const each = perPrompt(costs, k)
    lines.push(`  ${k.padEnd(14)} ${each === undefined ? 'measuring…' : `≈${Math.round(each * 100) / 100}%`}  (${costs[k]!.turns} turns)`)
  }
  const outcomes = await getOutcomes($)
  const missed = Object.entries(outcomes).filter(([, o]) => o.wrong + o.shallow > 0)
  if (missed.length) {
    lines.push('', 'Follow-ups that said a turn missed (kind | model·effort):')
    for (const [k, o] of missed) lines.push(`  ${k.padEnd(24)} ${o.wrong} wrong, ${o.shallow} cut corners, of ${o.turns} turns`)
  }
  lines.push('', `Sonnet checks so far: ${spent.calls}, ${spent.input.toLocaleString('en-US')} input + ${spent.output.toLocaleString('en-US')} output tokens.`)
  lines.push('', '/model-guard on | off | smart | local')
  return lines.join('\n')
}
