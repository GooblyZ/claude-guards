import { atom, read, update } from 'claude-code'
import type { Args, EngineInterface, Register } from 'claude-code'

import type { Day, GuardRow, Window } from '../types'
import {
  addToDay,
  SHARE,
  seedToday,
  bar,
  dateKey,
  dayLabel,
  fill,
  foldSession,
  meter,
  newSession,
  capSvg,
  pct,
  todayVerdict,
  tone,
  verdict,
  weekDelta,
  healDays,
  isNewWeek,
  type Reading,
} from './usage-logic'

const PANE = 'guards-usage'

export const meterAtom = atom({ plugin: 'guards', key: 'meter' } as const, null, { shape: 'meter-3' })
const sessionAtom = atom({ plugin: 'guards', key: 'session' } as const, null, { shape: 'sess-2' })
export const usageOnAtom = atom({ plugin: 'guards', key: 'usageOn' } as const, true)

async function getDays($: EngineInterface) {
  return ((await $.store.get('days')) ?? {}) as Record<string, Day>
}


// Module memory; a reload starts it over, the meter itself lives in $.state.
const mem: { readings: Reading[]; queue: Promise<unknown> } = { readings: [], queue: Promise.resolve() }

// Ledger writes run one at a time, so two readings never race.
const serial = <T,>(fn: () => Promise<T>) => {
  const run = mem.queue.then(fn, fn)
  mem.queue = run.catch(() => undefined)
  return run
}

// Fold fresh readings into the day ledger and your usual week, then redraw.
function measure($: EngineInterface, fresh?: Reading[]) {
  return serial(async () => {
    const now = await $.clock.now()
    let days = await getDays($)
    if (fresh?.length) {
      mem.readings = fresh
      const sess = (await read($, sessionAtom)) ?? newSession(now)
      await update($, sessionAtom, () => foldSession(sess, fresh))
      const week = fresh.find(r => r.kind === 'seven_day')
      if (week) {
        const w: Window = { pct: week.percentUsed, resetsAt: week.resetsAt ? Date.parse(week.resetsAt) : undefined }
        // Once, when counting starts: today's share of what the week used before it.
        if (!(await $.store.get('seeded'))) {
          days = seedToday(days, w, now)
          await $.store.set('days', days)
          await $.store.set('seeded', true)
        }
        const last = (await $.store.get('lastWeek')) as Window | undefined
        const delta = weekDelta(last, w)
        if (delta > 0) days = addToDay(days, now, delta)
        days = healDays(days, w, now)
        await $.store.set('days', days)
        // Keep the newest figure: an older one from another chat never replaces it.
        if (!last || isNewWeek(last, w) || w.pct >= last.pct) await $.store.set('lastWeek', w)
      }
    }
    // Before this session's first reply there are no readings yet: the last one stored stands in,
    // so the row shows where the week was rather than nothing.
    let readings = mem.readings
    const last = (await $.store.get('lastWeek')) as Window | undefined
    if (!readings.length && last?.resetsAt && last.resetsAt > now) {
      readings = [{ kind: 'seven_day', percentUsed: last.pct, resetsAt: new Date(last.resetsAt).toISOString() }]
    }
    // Whatever the reading, the days can't add up to more than the week: heal before drawing.
    const shown = readings.find(r => r.kind === 'seven_day')
    if (shown) {
      const healed = healDays(days, { pct: shown.percentUsed, resetsAt: shown.resetsAt ? Date.parse(shown.resetsAt) : undefined }, now)
      if (healed !== days) await $.store.set('days', (days = healed))
    }
    const m = meter(readings, days, now)
    await update($, meterAtom, () => m)
  })
}

export async function setUsageOn($: EngineInterface, isOn: boolean) {
  await update($, usageOnAtom, () => isOn)
  await $.store.set('usageOn', isOn)
}

/** Part of the shared `session.start` hook. */
export async function usageStart($: EngineInterface, e: Args<'session.start'>) {
  await $.command.register({
    name: 'usage-guard',
    description: 'Usage pane; /usage-guard on|off shows or hides the meter, /usage-guard table prints the days',
    argumentHint: '[on|off|table]',
  })
  if ((await $.store.get('usageOn')) === false) await update($, usageOnAtom, () => false)
  const usage = await $.session.usage()
  if (!(await read($, sessionAtom))) await update($, sessionAtom, () => newSession(usage.startedAt))
  await measure($, usage.rateLimits)
}

/** Part of the shared `session.measure` hook: pushed when a window moves a whole point. */
export async function usageMeasure($: EngineInterface, e: Args<'session.measure'>) {
  if (e.changed.includes('rateLimits') && e.rateLimits.length) await measure($, e.rateLimits)
}

/** Part of the shared `turn.complete` hook: the readings re-read carry the tenths session.measure skips. */
export async function usageTurnDone($: EngineInterface, e: Args<'turn.complete'>) {
  if (e.agentId === undefined) await measure($, (await $.session.usage()).rateLimits)
}

/** What the usage row says in the block. */
export async function usageRow($: EngineInterface): Promise<GuardRow> {
  const isOn = await read($, usageOnAtom)
  const m = await read($, meterAtom)
  const row = { name: 'Usage', isOn, flip: () => setUsageOn($, !isOn), text: '', note: '', extra: '', brief: '' }
  if (!isOn) return { ...row, note: 'off' }
  if (!m?.week || !m.pace) return { ...row, note: 'shows after the first reply' }
  const v = todayVerdict(m)
  const p = m.pace
  // 100% is today's allowance, carry from earlier days included; the math stays in one short line.
  const ofToday = p.todayBudget > 0.05 ? (m.todayUsed / p.todayBudget) * 100 : undefined
  // One sentence on where today stands with the days before it, in shares of the weekly limit.
  const even = pct(SHARE)
  const over = m.todayUsed - p.todayBudget
  const situation =
    over > 0.05
      ? `Today is ${pct(over)} of the weekly limit over its quota: the coming days have that much less.`
      : p.carry >= 0.5
        ? `+${pct(p.carry)} saved from earlier days: today has ${pct(p.todayBudget)} of the weekly limit instead of ${even}.`
        : p.carry <= -0.5
          ? `Earlier days took ${pct(-p.carry)} of today’s share: today has ${pct(p.todayBudget)} of the weekly limit instead of ${even}.`
          : `Earlier days were on an even pace: today has the usual ${even} of the weekly limit.`
  const text = ofToday !== undefined ? `Today ${Math.round(ofToday)}%` : `Today ${pct(m.todayUsed)} of the week`
  return {
    ...row,
    text,
    tone: v.tone,
    note: `${[v.word, m.five && m.five.pct >= 70 ? `5h ${pct(m.five.pct)}` : ''].filter(Boolean).join(' · ')} (week ${pct(m.week.pct)})`,
    extra: [v.tone === 'error' ? v.extra : '', situation].filter(Boolean).join(' '),
    brief: text,
    // Today's quota alone, empty to full: no second mark to read against.
    bar: { used: m.todayUsed, cap: p.todayBudget, tone: v.tone },
  }
}

export function registerUsage(on: Parameters<Register>[0]) {

  on('command.run', { command: 'usage-guard' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'on' || arg === 'off') {
      await setUsageOn($, arg === 'on')
      return { text: `usage-guard: ${arg} (usage is still recorded)` }
    }
    if (arg === 'table') return { text: await report($) }
    const { isPlaced } = await $.ui.open({ id: PANE, title: 'Usage guard' })
    return { text: isPlaced ? 'Usage guard pane opened.' : await report($) }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const m = await read($, meterAtom)
    const sess = await read($, sessionAtom)
    const days = await getDays($)
    const now = await $.clock.now()
    const { Box, Text } = $.ui.resolve(e)
    const cols = Math.max(30, e.props.bodyColumns)
    const barWidth = Math.min(20, Math.max(6, cols - 30))

    const row = (label: string, value: unknown, key?: string) => (
      <Box key={key}>
        <Box width={14}>
          <Text dimColor>{label}</Text>
        </Box>
        <Text wrap="truncate-end">{value}</Text>
      </Box>
    )
    const heading = (text: string) => (
      <Box marginTop={1}>
        <Text weight="bold">{text}</Text>
      </Box>
    )

    const keys = Object.keys(days).sort().slice(-14)
    const maxUsed = Math.max(1, ...keys.map(k => days[k]!.used))
    const hours = sess ? Math.max(0.25, (now - sess.startedAt) / 3_600_000) : 1
    const v = m?.week ? verdict(m.week, m.pace) : undefined

    return (
      <Box flexDirection="column">
        <Text weight="bold">This week</Text>
        {!m?.week || !v ? (
          <Text dimColor>Shows after the first reply of this session.</Text>
        ) : (
          <Box flexDirection="column">
            {row(
              'Used',
              <Text color={v.tone}>
                {bar(m.week.pct, barWidth)} {pct(m.week.pct)}
              </Text>,
            )}
            {m.pace && row('Even split', <Text>{pct(m.pace.expected)} by now</Text>)}
            {row('Verdict', <Text color={v.tone}>{v.word}</Text>)}
            {m.pace?.projected !== undefined && row('Week ends near', <Text>{pct(m.pace.projected)}</Text>)}
            {m.five && row('5-hour', <Text color={tone(m.five.pct / 100)}>{pct(m.five.pct)}</Text>)}
            <Text dimColor>An even week is 100% over 7 days, about 14.3% a day. What a day leaves unused goes to the next; what it overdraws comes out of them.</Text>
          </Box>
        )}

        {heading('Today')}
        {row('Spent', <Text>{pct(m?.todayUsed ?? 0)} of the weekly limit</Text>)}
        {m?.week && m.pace && row('Verdict', <Text color={todayVerdict(m).tone}>{todayVerdict(m).word}</Text>)}
        {m?.pace?.restDaily !== undefined && row('Days left', <Text>about {pct(m.pace.restDaily)} a day</Text>, 'rest-daily')}
        {m?.pace &&
          row(
            'Today’s allowance',
            <Text>
              {pct(m.pace.todayBudget)}
              <Text dimColor>
                {m.todayUsed <= m.pace.todayBudget ? ` · ${pct(m.pace.todayBudget - m.todayUsed)} left` : ' · past it, fine'}
              </Text>
            </Text>,
          )}

        {heading('This session')}
        {!sess || (sess.week === 0 && sess.five === 0) ? (
          <Text dimColor>Nothing measurable yet (readings move in 0.1% steps).</Text>
        ) : (
          row(
            'Took',
            <Text>
              {pct(sess.week)} of the week · {pct(sess.five)} of 5h
              <Text dimColor> · {pct(sess.week / hours)} of the week per hour</Text>
            </Text>,
          )
        )}

        {heading('Last 14 days')}
        {keys.length === 0 && <Text dimColor>No days recorded yet.</Text>}
        {keys.map(k => (
          <Box key={k}>
            <Box width={11}>
              <Text dimColor={k !== dateKey(now)}>{dayLabel(k)}</Text>
            </Box>
            <Box width={barWidth + 1}>
              <Text>{fill(days[k]!.used, maxUsed, barWidth) || '·'}</Text>
            </Box>
            <Text tabular>{pct(days[k]!.used)}</Text>
          </Box>
        ))}
      </Box>
    )
  })
}

async function report($: EngineInterface) {
  const m = await read($, meterAtom)
  const days = await getDays($)
  const lines = ['Usage guard — weekly limit spent per day', '']
  const keys = Object.keys(days).sort().slice(-14)
  if (!keys.length) lines.push('No days recorded yet.')
  const maxUsed = Math.max(1, ...keys.map(k => days[k]!.used))
  for (const k of keys) lines.push(`${dayLabel(k)}  ${fill(days[k]!.used, maxUsed, 12).padEnd(12)} ${pct(days[k]!.used).padStart(5)}`)
  if (m?.week) {
    const v = verdict(m.week, m.pace)
    lines.push('', `Week: ${pct(m.week.pct)} used${v.word ? `, ${v.word}` : ''}`)
    if (m.pace) {
      lines.push(`An even week would be at ${pct(m.pace.expected)} by now`)
      if (m.pace.projected !== undefined) lines.push(`At its pace so far the week ends near ${pct(m.pace.projected)}`)
      lines.push(`Today: ${pct(m.todayUsed)} of an even ${pct(m.pace.todayBudget)} (${todayVerdict(m).word})`)
    }
  }
  return lines.join('\n')
}
