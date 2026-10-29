// Pure logic: no `$`, no I/O. The reader (Sonnet) only describes the task; the policy
// here decides the model and effort, so every choice can be read and tuned.
//
// The policy works on two axes. The tier is what the work needs of the model
// (Haiku, Sonnet, Opus, Fable); the depth is how hard it must think (low to
// max). Among the options that meet both, the cheapest wins: a stronger model
// at a lower effort counts as meeting one step more of depth per tier, so
// Opus · low can stand in for Sonnet · high when it costs less. Costs are your
// own, measured per turn, once there are enough of them.
//
// Every rule cites a finding in RESEARCH.md as [n]: Anthropic's model, effort and
// cost guidance for the 5.5 generation.

import type { Cost, Need, Rec } from '../types'

const DAY = 24 * 3_600_000

export const clamp = (n: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, n))

const round = (n: number) => (n >= 10 ? Math.round(n) : Math.round(n * 10) / 10)

// ---------- the options ----------

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
const TIERS = ['', 'haiku', 'sonnet', 'opus', 'fable'] as const

export type Option = { model: string; effort: string; tier: number; depth: number; cost: number }

/**
 * Every model and effort, with a starting estimate of what a task costs, in US
 * cents per solved task. Measured by Anthropic where marked; the rest scaled from
 * those by token price and marked as estimates. Your measured costs replace them.
 */
export const OPTIONS: Option[] = [
  { model: 'haiku', effort: 'low', tier: 1, depth: 0, cost: 1.1 }, // about a twentieth of Opus [12]
  { model: 'sonnet', effort: 'low', tier: 2, depth: 0, cost: 3.7 }, // estimate: medium's step down again
  { model: 'sonnet', effort: 'medium', tier: 2, depth: 1, cost: 6.1 }, // 59% of high [10]
  { model: 'sonnet', effort: 'high', tier: 2, depth: 2, cost: 10.3 }, // Opus low divided by 1.07 [11]
  { model: 'opus', effort: 'low', tier: 3, depth: 0, cost: 11 }, // measured [10]
  { model: 'opus', effort: 'medium', tier: 3, depth: 1, cost: 21 }, // measured [10]
  { model: 'opus', effort: 'high', tier: 3, depth: 2, cost: 29 }, // measured [10]
  { model: 'opus', effort: 'xhigh', tier: 3, depth: 3, cost: 44 }, // estimate: 1.5x high
  { model: 'opus', effort: 'max', tier: 3, depth: 4, cost: 72 }, // estimate: 2.5x high
  { model: 'fable', effort: 'low', tier: 4, depth: 0, cost: 27 }, // estimates: Opus x 2.5, the price ratio [6]
  { model: 'fable', effort: 'medium', tier: 4, depth: 1, cost: 52 },
  { model: 'fable', effort: 'high', tier: 4, depth: 2, cost: 72 },
  { model: 'fable', effort: 'xhigh', tier: 4, depth: 3, cost: 110 },
  { model: 'fable', effort: 'max', tier: 4, depth: 4, cost: 180 },
]

export const family = (model: string) => {
  const m = model.toLowerCase()
  if (m.includes('haiku')) return 'haiku'
  if (m.includes('sonnet')) return 'sonnet'
  if (m.includes('opus')) return 'opus'
  if (m.includes('fable')) return 'fable'
  return m.replace(/^claude-/, '').split(/[-[]/)[0] || m
}

const effortName = (effort?: string | number) => (typeof effort === 'number' ? 'high' : effort ?? 'medium')

/** The key costs are recorded under: "opus·high". */
export const costKey = (model: string, effort?: string | number) => `${family(model)}·${family(model) === 'haiku' ? 'low' : effortName(effort)}`

export const optionOf = (model: string, effort?: string | number) => OPTIONS.find(o => `${o.model}·${o.effort}` === costKey(model, effort))

export const label = (model: string, effort?: string | number) => {
  const f = family(model)
  const name = f.charAt(0).toUpperCase() + f.slice(1)
  return effort === undefined || f === 'haiku' ? name : `${name} · ${effort}`
}

// ---------- your measured costs ----------

/** Weekly-% points one prompt takes on a model and effort, once three turns have been measured. */
export const perPrompt = (costs: Record<string, Cost>, key: string) => {
  const c = costs[key]
  // Readings move in 0.1% steps, so a few light turns can measure 0: that is too little to go on, not free.
  return c && c.turns >= 3 && c.week > 0 ? c.week / c.turns : undefined
}

/**
 * Each option's cost in weekly-% points: measured where known, else the
 * estimate scaled by how your measured options compare with their estimates.
 */
export const costOf = (costs: Record<string, Cost>) => {
  const ratios = OPTIONS.flatMap(o => {
    const m = perPrompt(costs, `${o.model}·${o.effort}`)
    return m !== undefined && m > 0 ? [m / o.cost] : []
  }).sort((a, b) => a - b)
  const scale = ratios.length ? ratios[Math.floor(ratios.length / 2)]! : undefined
  return (o: Option) => {
    const m = perPrompt(costs, `${o.model}·${o.effort}`)
    return { value: m ?? o.cost * (scale ?? 1), isMeasured: m !== undefined, isScaled: scale !== undefined }
  }
}

// ---------- what Haiku says about the task ----------

export const KINDS = ['unclear', 'trivial', 'question', 'ops', 'edit', 'content', 'bugfix', 'feature', 'refactor', 'research', 'architecture'] as const
const SIZES = ['tiny', 'small', 'medium', 'large'] as const
const LEVELS = ['low', 'medium', 'high'] as const
const TOPICS = ['continues', 'related', 'new'] as const

export type Features = {
  kind: (typeof KINDS)[number]
  scope: (typeof SIZES)[number]
  ambiguity: (typeof LEVELS)[number]
  risk: (typeof LEVELS)[number]
  topic: (typeof TOPICS)[number]
  deepReasoning: boolean
  priorFailures: boolean
  /** The work would run long on its own: past ~30 minutes of autonomous steps. */
  longRunning: boolean
  why: string
}

export const SYSTEM = `You describe one Claude Code prompt so that a fixed policy can pick a model for it. Do not pick a model yourself.

Read the prompt with the conversation so far. Judge the work it asks Claude to do, not how long or how technical the prompt is. A status note or a check-in that asks Claude to do nothing new is a question: a long pasted log with "what does this error mean" is a question; "go ahead" after a plan is that plan's work.

The kinds name the work, not the field: they apply to code, writing, images, video, data, business or anything else Claude is asked to do. For any ask a person could understand, in any language, pick the nearest kind by the work involved; when two fit, pick the one with more work.

Fields:
- kind: unclear (only gibberish or half-typed text; any understandable ask, in any language, is never unclear), trivial (a typo, rename, one-line change), question (explain or answer, no change), ops (run commands, git, installs), edit (a small known change, or writing short text), content (creative or content work that isn't code: images, ads, copy, video, posts, designs), bugfix (find and fix a fault), feature (new behaviour), refactor (restructure working code), research (compare, investigate, analyse), architecture (design a system or a change across many parts)
- scope: tiny (one spot), small (one file), medium (a few files), large (many files or many steps)
- ambiguity: low (the goal and the way are clear), medium, high (the goal is vague or needs decisions)
- risk: low, medium, high (security, payments, data loss, production)
- topic: continues (approves or carries on the work just discussed), related (a new ask about the same project or thread), new (unrelated to the conversation so far)
- deep_reasoning: true only when the task needs subtle reasoning: an intermittent or concurrency bug, a tricky algorithm, a design trade-off with real consequences, a large build with many interacting parts
- prior_failures: true when the conversation shows this already failed more than once
- long_running: true only when doing it would take Claude well over 30 minutes of autonomous work: a whole app or game, a codebase-wide migration, multistep deep research
- why: at most 6 words, English

Examples:
"rename getUser to fetchUser everywhere" -> {"kind":"edit","scope":"medium","ambiguity":"low","risk":"low","topic":"related","deep_reasoning":false,"prior_failures":false,"long_running":false,"why":"mechanical rename"}
"why is this test flaky? it passes locally" -> {"kind":"bugfix","scope":"small","ambiguity":"high","risk":"low","topic":"related","deep_reasoning":true,"prior_failures":false,"long_running":false,"why":"intermittent failure"}
"yes, do it" (after a plan to split the payment service) -> {"kind":"refactor","scope":"large","ambiguity":"low","risk":"high","topic":"continues","deep_reasoning":false,"prior_failures":false,"long_running":false,"why":"executing agreed refactor plan"}
"ok I restarted the app, checking if it works now" -> {"kind":"question","scope":"tiny","ambiguity":"low","risk":"low","topic":"related","deep_reasoning":false,"prior_failures":false,"long_running":false,"why":"status check-in"}
"create five realistic images of a bodybuilder" -> {"kind":"content","scope":"small","ambiguity":"low","risk":"low","topic":"new","deep_reasoning":false,"prior_failures":false,"long_running":false,"why":"image generation request"}
"what should we call the dog?" (while building a game with a dog in it) -> {"kind":"question","scope":"tiny","ambiguity":"low","risk":"low","topic":"related","deep_reasoning":false,"prior_failures":false,"long_running":false,"why":"naming question"}
"build a 3D racing game with physics, AI opponents and multiplayer" -> {"kind":"architecture","scope":"large","ambiguity":"medium","risk":"low","topic":"new","deep_reasoning":true,"prior_failures":false,"long_running":true,"why":"large multi-system build"}

Reply with one JSON object only, no prose.`

export type Turn = { role: 'user' | 'assistant'; text: string }

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text)

/** The draft, the session's first ask (what the project is) and the last few messages. */
export const buildAsk = (draft: string, first: string | undefined, recent: Turn[]) => {
  const lines: string[] = []
  if (first) lines.push(`The session began with: ${clip(first.replace(/\s+/g, ' ').trim(), 400)}`, '')
  lines.push('Latest messages (oldest first):')
  if (!recent.length) lines.push('(none: this is the first prompt)')
  for (const t of recent) lines.push(`${t.role === 'user' ? 'User' : 'Assistant'}: ${clip(t.text.replace(/\s+/g, ' ').trim(), 500)}`)
  // A long prompt keeps its head and tail, where the ask usually is.
  const body = draft.length > 4000 ? `${draft.slice(0, 2500)}\n[… ${draft.length - 3500} characters left out …]\n${draft.slice(-1000)}` : draft
  lines.push('', 'The prompt to describe:', '<prompt>', body, '</prompt>')
  return lines.join('\n')
}

const pick = <T extends string>(list: readonly T[], value: unknown, fallback: T): T =>
  (list as readonly string[]).includes(String(value).toLowerCase()) ? (String(value).toLowerCase() as T) : fallback

/** Read Haiku's reply; undefined when it is not the JSON asked for. */
export const parseFeatures = (text: string): Features | undefined => {
  const json = text.match(/\{[\s\S]*\}/)?.[0]
  if (!json) return undefined
  try {
    const r = JSON.parse(json) as Record<string, unknown>
    if (!(KINDS as readonly string[]).includes(String(r.kind).toLowerCase())) return undefined
    return {
      kind: pick(KINDS, r.kind, 'edit'),
      scope: pick(SIZES, r.scope, 'small'),
      ambiguity: pick(LEVELS, r.ambiguity, 'low'),
      risk: pick(LEVELS, r.risk, 'low'),
      topic: pick(TOPICS, r.topic, 'related'),
      deepReasoning: r.deep_reasoning === true,
      priorFailures: r.prior_failures === true,
      longRunning: r.long_running === true,
      why: clip(String(r.why ?? '').trim(), 60),
    }
  } catch {
    return undefined
  }
}

// ---------- what the work needs ----------

const CODE = new Set<Features['kind']>(['bugfix', 'feature', 'refactor', 'architecture'])

/** The tier and depth the task needs, from Haiku's description. */
export const needOf = (f: Features): Need => {
  const isLarge = f.scope === 'large'
  const isCode = CODE.has(f.kind)
  // Tier: smaller models for routine, clearly specified work; larger for the ambiguous [2][4].
  let tier = 1
  // Content creation is Sonnet's own [2].
  if (f.kind === 'bugfix' || f.kind === 'feature' || f.kind === 'refactor' || f.kind === 'research' || f.kind === 'content') tier = 2
  if (f.kind === 'edit' && (f.scope === 'medium' || isLarge)) tier = 2
  if (f.ambiguity !== 'low' && f.kind !== 'trivial') tier = Math.max(tier, 2)
  if (
    f.kind === 'architecture' ||
    f.deepReasoning ||
    (isCode && (isLarge || f.ambiguity === 'high')) ||
    (f.risk === 'high' && f.scope !== 'tiny') ||
    (f.priorFailures && isCode)
  ) {
    tier = 3
  }
  // Fable: hours-long deep research or open-ended design, or deep work Opus already fell short on
  // [1][2][3]. Long autonomous coding stays on Opus, which is built for it [2].
  const isHours = f.longRunning && f.deepReasoning && (f.kind === 'research' || (f.kind === 'architecture' && f.ambiguity === 'high'))
  if (isHours || (f.deepReasoning && f.priorFailures && (f.kind === 'architecture' || isLarge))) tier = 4

  // Depth: medium for day-to-day work with a clear scope [8][9]; low for quick exchanges and
  // small changes; high where verification matters (a bug in existing code, risk, a vague goal);
  // xhigh only for work that runs long; max only for deep work that already failed [3][8][14].
  let depth = 1
  const isQuick = f.kind === 'trivial' || f.kind === 'ops' || (f.kind === 'question' && f.ambiguity === 'low') || (f.kind === 'edit' && f.scope === 'tiny')
  if (isQuick) depth = 0
  if ((f.kind === 'bugfix' && f.scope !== 'tiny') || f.risk !== 'low' || f.ambiguity === 'high' || f.deepReasoning) depth = Math.max(depth, 2)
  if (f.longRunning) depth = Math.max(depth, 3)
  if (f.deepReasoning && f.priorFailures && (f.longRunning || isLarge || f.kind === 'architecture')) depth = 4
  // Deep research on Fable gained nothing from effort: 66% at low, 65% at high [13].
  if (tier === 4 && f.kind === 'research') depth = 0
  return { tier, depth }
}

// ---------- budget ----------

export type Reading = { kind: string; percentUsed: number; resetsAt?: string }
export type Budget = { steps: number; why: string }

/** Where today stands, from the usage side: past its allowance, and whether the week is running short. */
export type Today = { isOver: boolean; isShort: boolean }

/**
 * How many steps your limits take the advice down. Only what is certain counts:
 * a 5-hour window nearly full (a step from 85%, two from 95%), today past its
 * allowance (a step), or a week already running short (a step). A forecast of
 * the week does not: days you don't use Claude would make it wrong.
 */
export const budget = (list: Reading[], _now: number, today?: Today): Budget => {
  let steps = 0
  const why: string[] = []
  const five = list.find(r => r.kind === 'five_hour')
  if (five && five.percentUsed >= 85) {
    steps = five.percentUsed >= 95 ? 2 : 1
    why.push(`5-hour window ${round(five.percentUsed)}%`)
  }
  if (today?.isOver && steps < 2) {
    steps += 1
    why.push('past today’s allowance')
  }
  if (today?.isShort && steps < 2) {
    steps += 1
    why.push('the week is running short')
  }
  return { steps: Math.min(2, steps), why: why.join(', ') }
}

// ---------- the decision ----------

/** Does an option meet a need? One more tier stands in for one step of depth. */
const meets = (o: Option, need: Need) => o.tier >= need.tier && o.depth >= need.depth - (o.tier - need.tier)

export type Context = {
  budget: Budget
  costs: Record<string, Cost>
  actual?: { model: string; effort?: string | number }
  /** Tokens in the conversation now. */
  context?: number
  topic?: Features['topic']
  /** The kind of task, and how each option fared on that kind for you. */
  kind?: string
  outcomes?: Record<string, Outcome>
}

/** How one option fared on one kind of task: turns, and the misses that followed them. */
export type Outcome = { turns: number; wrong: number; shallow: number }

export const outcomeKey = (kind: string, model: string, effort: string) => `${kind}|${model}·${effort}`

/**
 * A follow-up that says the last turn missed. "Still broken", "wrong": it didn't
 * know enough, so the model should rise. "You skipped", "didn't test": it didn't
 * try hard enough, so the effort should [5].
 */
export const missOf = (text: string): 'wrong' | 'shallow' | undefined => {
  const t = text.toLowerCase()
  if (/you (skipped|missed|forgot)|didn'?t (test|check|run|read|verify)|דילגת|פספסת|שכחת|לא בדקת|לא הרצת|לא קראת/.test(t)) return 'shallow'
  if (/still (not|doesn'?t|fails?|broken|wrong)|(doesn'?t|didn'?t|not) work|same (error|bug)|that'?s wrong|עדיין לא|לא עובד|לא עבד|אותה שגיאה|זה לא נכון|לא תקין/.test(t)) return 'wrong'
  return undefined
}

/**
 * The cheapest option that meets the need, after the budget and the cost of
 * leaving the running model are counted.
 */
export const decide = (need: Need, why: string, source: Rec['source'], c: Context): Rec => {
  // Options rank by the research's cost per solved task, never by your per-prompt measurements:
  // those follow what you happened to run on each option (short tests on one, heavy work on
  // another), not what the option costs.
  const cheapest = (n: Need, among = OPTIONS) =>
    among.filter(o => meets(o, n)).sort((a, b) => a.cost - b.cost)[0] ?? OPTIONS[OPTIONS.length - 1]!

  // The budget gives up depth first, then a tier, never below Sonnet for work that needs Opus.
  let target = need
  if (c.budget.steps) {
    const depth = Math.max(0, need.depth - c.budget.steps)
    const left = c.budget.steps - (need.depth - depth)
    target = { tier: Math.max(need.tier - left, need.tier >= 3 ? 2 : 1, need.tier - 1), depth }
  }
  let o = cheapest(target)
  const notes: string[] = []
  if (target !== need && o.cost < cheapest(need).cost) notes.push(`Stepped down to save your limits: ${c.budget.why}.`)

  // A lighter model mid-conversation re-reads the whole context without the cache,
  // and starts without what the running model has worked out. Past 40k tokens a
  // follow-up stays on the running model, at the effort it needs there.
  const current = c.actual ? optionOf(c.actual.model, c.actual.effort) : undefined
  const k = c.context ? `${Math.round(c.context / 1000)}k` : ''
  let stayed = false
  if (current && o.tier < current.tier && (c.context ?? 0) >= 40_000) {
    if (c.topic === 'new') {
      notes.push(`New topic: start a fresh chat (/clear) first, so ${label(o.model, o.effort)} doesn’t re-read this one.`)
    } else {
      o = cheapest(target, OPTIONS.filter(x => x.model === current.model))
      stayed = true
      notes.push(`Staying on ${label(current.model)}: switching would re-read this chat’s ${k} tokens without the cache.`)
    }
  }
  // An upgrade mid-conversation costs a full re-read too: name the strongest effort on the running
  // model as the no-switch alternative, since an effort change keeps the cache [15][16].
  if (current && o.tier > current.tier && (c.context ?? 0) >= 40_000 && c.topic !== 'new') {
    const stay = OPTIONS.filter(x => x.model === current.model && x.depth >= Math.min(4, target.depth + 1)).sort((x, y) => x.depth - y.depth)[0]
    if (stay) notes.push(`Or stay on ${label(stay.model)} at ${stay.effort}: no re-read of this chat’s ${k} tokens, slightly less capable.`)
  }

  // Your own record: an option that missed on a third or more of this kind of task, over three
  // or more turns, gives way to the step above it; wrong answers raise the model, shallow ones
  // the effort [5][14].
  const first = o
  const record = c.kind ? c.outcomes?.[outcomeKey(c.kind, o.model, o.effort)] : undefined
  if (record && record.turns >= 3 && (record.wrong + record.shallow) / record.turns >= 1 / 3) {
    const up = record.wrong >= record.shallow ? { tier: Math.min(4, o.tier + 1), depth: o.depth } : { tier: o.tier, depth: Math.min(4, o.depth + 1) }
    const better = cheapest(up)
    if (better !== o) {
      o = better
      notes.push(`Raised: ${label(first.model, first.effort)} missed on ${record.wrong + record.shallow} of ${record.turns} similar tasks for you.`)
    }
  }

  // Fable can draw on usage credits rather than the plan's limits [7].
  if (o.model === 'fable') notes.push('Fable may bill to usage credits instead of your plan; the /model picker says when.')

  // A costly pick also names the step below it: the best fit and a cheaper one, your call.
  // Having stayed on the running model to keep the cache, the step below stays on it too.
  if (o.tier >= 3 && (o.depth >= 2 || o.tier === 4)) {
    const among = stayed ? OPTIONS.filter(x => x.model === o.model) : OPTIONS
    const relaxed = o.depth > 0 ? { tier: o.tier, depth: o.depth - 1 } : { tier: o.tier - 1, depth: o.depth }
    const alt = cheapest(target.depth > 0 ? { tier: target.tier, depth: target.depth - 1 } : { tier: target.tier - 1, depth: 0 }, among)
    const lighter = alt.cost < o.cost ? alt : cheapest(relaxed, among)
    if (lighter.cost < o.cost) {
      notes.unshift(`Lighter option: ${label(lighter.model, lighter.effort)}, about ${round(o.cost / lighter.cost)}× less. It may need more back-and-forth.`)
    }
  }
  return { model: o.model, effort: o.effort, need: target, why, notes, source, kind: c.kind }
}

// ---------- the local rules (no tokens) ----------

type Rule = { why: string; score: number; words: string[] }

const RULES: Rule[] = [
  {
    why: 'architecture / design',
    score: 4,
    words: ['architect', 'ארכיטקטור', 'redesign', 'refactor', 'ריפקטור', 'migrat', 'מיגרצי', 'rewrite', 'from scratch', 'מאפס', 'system design', 'תכנון מערכת', 'תוכנית', 'תכנן', 'plan ', 'strategy', 'אסטרטגי'],
  },
  {
    why: 'debugging',
    score: 3,
    words: ['bug', 'באג', 'error', 'שגיאה', 'exception', 'crash', 'קורס', 'נקרס', 'not working', 'לא עובד', 'fails', 'failing', 'נכשל', 'debug', 'דיבאג', 'race condition', 'leak', 'stack trace', 'traceback', 'why does', 'למה זה'],
  },
  {
    why: 'new feature',
    score: 2,
    words: ['implement', 'build', 'create', 'add ', 'feature', 'תבנה', 'תוסיף', 'להוסיף', 'צור ', 'תיצור', 'מנגנון', 'פיצ\'ר', 'integrat', 'אינטגרצי', 'mod', 'plugin', 'api'],
  },
  {
    why: 'high-risk area',
    score: 2,
    words: ['security', 'אבטח', 'production', 'פרודקשן', 'prod ', 'auth', 'הרשא', 'payment', 'תשלום', 'database', 'מסד נתונים', 'schema', 'concurren', 'מקביל', 'encrypt', 'הצפנ'],
  },
  {
    why: 'repeat attempt',
    score: 2,
    words: ['still', 'again', 'didn\'t work', 'doesnt work', 'עדיין', 'שוב', 'לא עבד', 'עוד פעם', 'same error', 'אותה שגיאה'],
  },
  {
    why: 'analysis / research',
    score: 2,
    words: ['analy', 'נתח', 'ניתוח', 'compare', 'השווא', 'research', 'מחקר', 'investigate', 'trade-off', 'tradeoff', 'review', 'סקירה'],
  },
]

const TRIVIAL = ['typo', 'rename', 'שנה שם', 'translate', 'תרגם', 'format', 'פרמט', 'what is', 'מה זה', 'how do i', 'איך עושים', 'explain', 'הסבר', 'list ', 'show me', 'תראה לי', 'commit', 'קומיט', 'small', 'קטן', 'quick', 'מהיר']

const FOLLOW_UP = /^\s*(yes|yep|ok|okay|go|go ahead|continue|do it|proceed|sure|כן|אוקיי|אוקי|יאללה|תמשיך|המשך|סבבה|תעשה|בצע|מעולה)[\s.!]*$/i

export const isFollowUp = (text: string) => FOLLOW_UP.test(text)

export type Difficulty = { score: number; reasons: string[]; isFollowUp: boolean }

export const difficulty = (raw: string, previous?: number): Difficulty => {
  const text = raw.toLowerCase()
  if (FOLLOW_UP.test(text)) return { score: previous ?? 4, reasons: ['continues the previous request'], isFollowUp: true }

  let score = 2
  const hits: { why: string; score: number }[] = []
  for (const rule of RULES) {
    if (rule.words.some(w => text.includes(w))) hits.push(rule)
  }
  score += hits.reduce((s, h) => s + h.score, 0)

  const subRequests =
    (raw.match(/^\s*(?:[-*•]|\d+[.)])\s+/gm)?.length ?? 0) +
    (text.match(/\b(also|additionally|and then)\b|בנוסף|וגם|כמו כן|ובנוסף|חוץ מזה/g)?.length ?? 0)
  if (subRequests > 0) {
    score += Math.min(3, subRequests * 0.7)
    hits.push({ why: `${subRequests + 1} sub-requests`, score: subRequests })
  }

  if (/```|\n\s+at |Traceback|Error:/.test(raw)) {
    score += 1
    hits.push({ why: 'code / logs attached', score: 1 })
  }

  const isTrivial = TRIVIAL.some(w => text.includes(w))
  if (isTrivial && hits.length <= 1) {
    score -= 2
    hits.push({ why: 'small, contained task', score: 0.5 })
  }
  if (raw.length < 60 && hits.length === 0) {
    score -= 1
    hits.push({ why: 'short question', score: 0 })
  }

  const reasons = [...hits].sort((a, b) => b.score - a.score).slice(0, 2).map(h => h.why)
  return { score: Math.round(clamp(score, 0, 10) * 10) / 10, reasons, isFollowUp: false }
}

/**
 * The need from the local rules. Without Haiku there is no sign of deep
 * reasoning, so they stop at Opus · high; a follow-up keeps the last need.
 */
export const needFromRules = (d: Difficulty, previous?: Need): Need => {
  if (d.isFollowUp && previous) return previous
  const s = d.score
  if (s <= 2) return { tier: 1, depth: 0 }
  if (s <= 4) return { tier: 2, depth: 1 }
  if (s <= 5.5) return { tier: 2, depth: 2 }
  if (s <= 7) return { tier: 3, depth: 1 }
  return { tier: 3, depth: 2 }
}

/** "Go ahead" needs what the work it continues needed. */
export const withPrevious = (need: Need, f: Features, previous?: Need): Need =>
  // A status note or a check-in ("I restarted, does it work?") is a question, not that work.
  f.topic === 'continues' && previous && !QUICK.has(f.kind)
    ? { tier: Math.max(need.tier, previous.tier), depth: Math.max(need.depth, previous.depth) }
    : need

const QUICK = new Set<Features['kind']>(['question', 'trivial', 'ops', 'unclear'])

// ---------- what you are told ----------

/** What the block says: the suggestion, a short reason, and any longer note for the line below. */
export type Advice = { tone: 'fits' | 'lighter' | 'heavier' | 'effort'; text: string; note: string; extra: string }

export const advise = (rec: Rec, actual: { model: string; effort?: string | number } | null, _costs?: Record<string, Cost>): Advice => {
  const suggestion = label(rec.model, rec.effort)
  const current = actual ? optionOf(actual.model, actual.effort) : undefined
  const said = (tone: Advice['tone'], text: string, more: string[] = []) => ({ tone, text, note: rec.why, extra: [...rec.notes, ...more].join(' ') })
  if (!actual || !current) return said('fits', suggestion)
  const fits = `${label(actual.model)} ✓ fits`
  // On the running model: when the effort running is known, say whether it fits; when it isn't
  // (no turn yet, no desktop state to read), name the effort to use and nothing more.
  if (current.model === rec.model) {
    if (actual.effort === undefined) return said('effort', suggestion)
    if (current.effort === rec.effort) return said('fits', `${label(actual.model, rec.effort)} ✓ fits`)
    return said('effort', `Set effort to ${rec.effort}`, [`${label(rec.model, rec.effort)} fits this; you're on ${current.effort}. Effort changes keep the cache.`])
  }
  // How much less, from the research's cost per solved task: your own measurements follow the
  // work you ran on each option and would mislead here.
  const then = OPTIONS.find(o => o.model === rec.model && o.effort === rec.effort)!
  if (then.cost < current.cost) {
    const times = current.cost / then.cost
    const saves = Number.isFinite(times) ? `${suggestion} costs about ${round(times)}× less than ${label(current.model, current.effort)}.` : ''
    return said('lighter', `Try ${suggestion}`, saves ? [saves] : [])
  }
  // The running option costs less: say so only when it falls short of the need.
  if (meets(current, rec.need)) return said('fits', fits)
  return said('heavier', `Consider ${suggestion}`)
}

export const tierName = (tier: number) => TIERS[tier] ?? ''
