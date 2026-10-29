// Pure logic: no `$`, no I/O. The figures come from the engine's own
// rate-limit readings, so the mod never spends a token.

import type { Day, Meter, Pace, Sess, Window } from '../types'

export const HOUR = 3_600_000
export const DAY = 24 * HOUR
const WEEK = 7 * DAY

export const clamp = (n: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, n))

export const dateKey = (ms: number) => {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

const startOfDay = (ms: number) => {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

export const newSession = (now: number): Sess => ({ startedAt: now, week: 0, five: 0 })

// ---------- readings ----------

export type Reading = { kind: string; percentUsed: number; resetsAt?: string }

export const windowOf = (list: Reading[], kind: string): Window | undefined => {
  const r = list.find(x => x.kind === kind)
  if (!r) return undefined
  return { pct: r.percentUsed, resetsAt: r.resetsAt ? Date.parse(r.resetsAt) : undefined }
}

/** What the weekly % grew by since the last reading; a reset counts the new value. */
export const weekDelta = (last: Window | undefined, week: Window) => {
  if (!last) return 0
  const isReset = (week.resetsAt ?? 0) > (last.resetsAt ?? 0) + HOUR || week.pct < last.pct
  return Math.max(0, isReset ? week.pct : week.pct - last.pct)
}

/** Count one weekly delta to today, keeping three weeks of days. */
export const addToDay = (days: Record<string, Day>, now: number, delta: number) => {
  const key = dateKey(now)
  const next = { ...days, [key]: { used: round1((days[key]?.used ?? 0) + delta) } }
  const cutoff = dateKey(now - 21 * DAY)
  for (const k of Object.keys(next)) if (k < cutoff) delete next[k]
  return next
}

/**
 * What the week used before counting began, given to today by the share of
 * the window's time so far that falls today: a week that reset last night has
 * spent most of its points today. Never lowers what today has counted.
 */
export const seedToday = (days: Record<string, Day>, week: Window, now: number) => {
  if (week.resetsAt === undefined) return days
  const start = week.resetsAt - WEEK
  const share = now > start ? clamp((now - Math.max(start, startOfDay(now))) / (now - start)) : 0
  const key = dateKey(now)
  const seed = round1(week.pct * share)
  return (days[key]?.used ?? 0) >= seed ? days : { ...days, [key]: { used: seed } }
}

/** Add what the windows grew by since the last reading to this session's spend. */
export const foldSession = (s: Sess, list: Reading[]): Sess => {
  const five = windowOf(list, 'five_hour')
  const week = windowOf(list, 'seven_day')
  const next = { ...s }
  if (week) {
    if (s.lastWeek !== undefined) next.week += week.pct >= s.lastWeek ? week.pct - s.lastWeek : week.pct
    next.lastWeek = week.pct
  }
  if (five) {
    if (s.lastFive !== undefined) {
      const isReset = five.pct < s.lastFive || (five.resetsAt ?? 0) > (s.lastFiveReset ?? 0) + HOUR
      next.five += isReset ? five.pct : five.pct - s.lastFive
    }
    next.lastFive = five.pct
    next.lastFiveReset = five.resetsAt
  }
  next.week = round1(next.week)
  next.five = round1(next.five)
  return next
}

// ---------- an even week ----------

/** An even split of the weekly limit: 100% over 7 days, about 14.3% a day. A share, not a cap. */
export const SHARE = 100 / 7

export const pace = (week: Window, todayUsed: number, now: number): Pace | undefined => {
  if (week.resetsAt === undefined) return undefined
  const start = week.resetsAt - WEEK
  const even = (t: number) => 100 * clamp((Math.min(t, week.resetsAt!) - start) / WEEK)
  const done = clamp((now - start) / WEEK)
  const dayStart = Math.max(start, startOfDay(now))
  const dayEnd = startOfDay(now) + DAY
  const usedBefore = Math.max(0, week.pct - todayUsed)
  // Where an even week would be by now, and where this one ends at its pace so far.
  const expected = even(now)
  const projected = done > 0.05 ? week.pct / done : undefined
  // What earlier days left (or overdrew) against an even week, carried into today:
  // today's allowance is where an even week stands at midnight, less what came before.
  const carry = even(dayStart) - usedBefore
  const todayBudget = Math.max(0, even(dayEnd) - usedBefore)
  // Where today would be by now on an even pace, the carry included: the bar's tick.
  const todayUsual = Math.max(0, expected - usedBefore)
  // What's left of the limit, spread over the time left until the reset.
  const daysLeft = (week.resetsAt - now) / DAY
  const restDaily = daysLeft >= 0.25 ? Math.max(0, 100 - week.pct) / daysLeft : undefined
  return { expected, projected, todayBudget, todayUsual, carry, restDaily }
}

/**
 * How today stands against its allowance. Going past it is allowed and says so
 * plainly: the days ahead get a little less. Red only when they'd be squeezed
 * below half an even day.
 */
export const todayVerdict = (m: Meter): Verdict => {
  const p = m.pace
  if (!p || !m.week) return { word: '', tone: 'success' }
  if (p.restDaily !== undefined && p.restDaily < SHARE / 2) {
    return { word: 'week running short', tone: 'error', extra: `The days left have about ${pct(p.restDaily)} each.` }
  }
  if (m.todayUsed > p.todayBudget) {
    return { word: 'past today’s share', tone: 'warning', extra: 'That’s fine: the days ahead get a little less.' }
  }
  return { word: 'on track', tone: 'success' }
}

/** A verdict in a few words, and when it isn't good news, a plain sentence of what it means. */
export type Verdict = { word: string; tone: 'success' | 'warning' | 'error'; extra?: string }

/** How the week stands against your pace, in a few words. */
export const verdict = (week: Window, p: Pace | undefined): Verdict => {
  if (!p) return { word: '', tone: tone(week.pct / 100) }
  if (p.projected !== undefined && p.projected >= 100) return { word: `ends near ${pct(p.projected)}`, tone: 'error' }
  const ahead = week.pct - p.expected
  if (ahead > 3) return { word: `${pct(ahead)} ahead of an even week`, tone: p.projected !== undefined && p.projected >= 90 ? 'error' : 'warning' }
  if (ahead < -3) return { word: 'room to spare', tone: 'success' }
  return { word: 'on pace', tone: 'success' }
}

export const meter = (list: Reading[], days: Record<string, Day>, now: number): Meter => {
  const five = windowOf(list, 'five_hour')
  const week = windowOf(list, 'seven_day')
  const todayUsed = days[dateKey(now)]?.used ?? 0
  return { five, week, todayUsed, pace: week ? pace(week, todayUsed, now) : undefined }
}

// ---------- text ----------

const round1 = (n: number) => Math.round(n * 10) / 10

export const round = (n: number) => (n >= 10 ? Math.round(n) : round1(n))

export const pct = (n: number) => `${round(n)}%`

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export const bar = (p: number, width = 10) => {
  const full = Math.round(clamp(p / 100) * width)
  return '▰'.repeat(full) + '▱'.repeat(width - full)
}

/** A bar of `width` cells for value / max, with eighth-cell precision. */
export const fill = (value: number, max: number, width: number) => {
  const eighths = Math.round(clamp(max > 0 ? value / max : 0) * width * 8)
  const tail = eighths % 8 ? '▏▎▍▌▋▊▉'[(eighths % 8) - 1] : ''
  return '█'.repeat(Math.floor(eighths / 8)) + tail
}

/** success under 60% of the limit, warning under 85%, error above. */
export const tone = (ratio: number): Verdict['tone'] => (ratio < 0.6 ? 'success' : ratio < 0.85 ? 'warning' : 'error')

const HEX = { success: '#5DCAA5', warning: '#EF9F27', error: '#E24B4A' }

/** The desktop's bar: today's spend against its even share, and a tick where an even day is by this hour. */
export const capSvg = (used: number, cap: number, usual: number | undefined, t: Verdict['tone']) => {
  const W = 72
  const x = (p: number) => Math.round((clamp(cap > 0 ? p / cap : 1) * (W - 2) + 1) * 10) / 10
  const tick = usual === undefined ? '' : `<rect x="${x(usual) - 1}" y="0" width="2" height="10" rx="1" fill="#d6d4ca"/>`
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="10" viewBox="0 0 ${W} 10"><rect x="0" y="3" width="${W}" height="4" rx="2" fill="#8a887f" fill-opacity="0.35"/><rect x="0" y="3" width="${x(used)}" height="4" rx="2" fill="${HEX[t]}"/>${tick}</svg>`
}

export const dayLabel = (key: string) => {
  const [y, m, d] = key.split('-').map(Number)
  const date = new Date(y!, m! - 1, d!)
  return `${WEEKDAYS[date.getDay()]} ${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}`
}
