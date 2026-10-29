import { expect, mock, test } from 'claude-code/testing'

const NOW = Date.parse('2026-10-28T12:00:00')
const H = 3_600_000
const D = 24 * H

const READINGS = [
  { kind: 'five_hour', percentUsed: 12, resetsAt: new Date(NOW + 3 * H).toISOString() },
  { kind: 'seven_day', percentUsed: 30, resetsAt: new Date(NOW + 4 * D).toISOString() },
]

const BAND = {
  plugin: 'guards',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 140 },
} as const

type On = Parameters<Parameters<typeof test>[1]>[1]

// Stands for the engine beneath the mod; `reply` is what Haiku answers.
const engine = (on: On, reply = '{"kind":"feature"}', calls = { n: 0 }, seed: Record<string, unknown> = {}, readings: typeof READINGS = READINGS) => {
  const clock = mock.clock(on, { now: NOW })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({
    value: { startedAt: NOW - H, context: { window: 200000, tokens: 12000, apiUsage: null }, rateLimits: readings },
  }))
  on('session.messages', () => ({ value: [{ role: 'user', text: 'the login page throws on submit', toolUses: [] }] }))
  on('model.complete', () => {
    calls.n += 1
    return {
      value: {
        isAnswered: true,
        text: reply,
        usage: { input_tokens: 1400, output_tokens: 60, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    }
  })
  on('prompt.change', (_, e) => ({ text: e.text, cursor: e.cursor }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.render', (_$, e) => {
    const { Text } = _$.ui.resolve(e)
    return <Text>beneath</Text>
  })
  const store = new Map<string, unknown>(Object.entries(seed))
  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.set', (_, e) => (store.set(e.key, e.value), { value: undefined }))
  return clock
}

const has = async (ui: { find: (q: { type: 'Text'; text: RegExp }) => Promise<unknown> }, text: RegExp) =>
  (await ui.find({ type: 'Text', text })) !== undefined

test('the block shows a row per guard, keeps what is drawn beneath, and folds to one line', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await has(ui, /^Usage$/)).toBe(true)
    expect(await has(ui, /^Today \d+%$/)).toBe(true)
    expect(await has(ui, /advice shows as you type/)).toBe(true)
    expect(await has(ui, /beneath/)).toBe(true)

    await ui.press({ key: 'guards-fold' })
    expect(await has(ui, /advice shows as you type/)).toBe(false)
    expect(await has(ui, /Today \d+%/)).toBe(true)
    await ui.press({ key: 'guards-fold' })
    expect(await has(ui, /advice shows as you type/)).toBe(true)
    await ui.unmount()
  }
})

test('each switch turns its guard off and on alone, on every surface', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    await ui.press({ key: 'guards-model-switch' })
    expect(await has(ui, /advice shows as you type/)).toBe(false)
    expect(await has(ui, /^Today \d+%$/)).toBe(true)
    await ui.press({ key: 'guards-usage-switch' })
    expect(await has(ui, /^Today \d+%$/)).toBe(false)
    await ui.press({ key: 'guards-model-switch' })
    await ui.press({ key: 'guards-usage-switch' })
    expect(await has(ui, /advice shows as you type/)).toBe(true)
    expect(await has(ui, /^Today \d+%$/)).toBe(true)
    await ui.unmount()
  }
  expect((await $.command.run({ command: 'model-guard', args: 'off' })).text).toBe('model-guard: off')
})

test('the model row shows local advice at once, then the policy’s once Haiku describes the task', async ($, on) => {
  const calls = { n: 0 }
  const clock = engine(
    on,
    '{"kind":"bugfix","scope":"small","ambiguity":"high","risk":"low","topic":"related","deep_reasoning":true,"prior_failures":false,"why":"intermittent auth failure"}',
    calls,
  )
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.change({ text: 'fix the typo in the README title please', cursor: 0, origin: { kind: 'history' } })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await has(ui, /Try Haiku/)).toBe(true)
  expect(calls.n).toBe(0)
  await clock.advance(1500)
  expect(calls.n).toBe(1)
  expect(await has(ui, /^Opus · high$/)).toBe(true)
  expect(await has(ui, /✦ intermittent auth failure/)).toBe(true)
  await ui.unmount()
})

test('a draft Haiku can’t read gets no advice', async ($, on) => {
  const clock = engine(on, '{"kind":"unclear","scope":"tiny","ambiguity":"high","risk":"low","topic":"new","why":"gibberish"}')
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.change({ text: 'גדכגדכ גדכגכ דגכדגכגדכ גדכגדכ', cursor: 0, origin: { kind: 'history' } })
  await clock.advance(1500)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await has(ui, /can’t tell what this asks yet/)).toBe(true)
  expect(await has(ui, /Try|Consider|fits/)).toBe(false)
  await ui.unmount()
})

test('the main switch stops everything and leaves one "Guards off" line; its switch turns them back on', async ($, on) => {
  const calls = { n: 0 }
  const clock = engine(on, '{"kind":"feature"}', calls)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    await ui.press({ key: 'guards-main-switch' })
    expect(await has(ui, /^Guards off$/)).toBe(true)
    expect(await has(ui, /^Usage$|^Model$/)).toBe(false)
    expect(await has(ui, /beneath/)).toBe(true)

    await $.prompt.change({ text: 'implement the export feature and debug the crash', cursor: 0, origin: { kind: 'history' } })
    await clock.advance(5000)
    expect(calls.n).toBe(0)

    await ui.press({ key: 'guards-main-switch' })
    expect(await has(ui, /^Usage$/)).toBe(true)
    expect(await has(ui, /^Model$/)).toBe(true)
    await ui.unmount()
  }
  expect((await $.command.run({ command: 'guards', args: 'off' })).text).toBe('guards: off in every chat. /guards on brings it back.')
  expect((await $.command.run({ command: 'guards', args: 'on' })).text).toBe('guards: on')
})

test('the ✕ hides the block in this chat alone, and /guards show brings it back', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'guards-hide' })
  expect(await has(ui, /Usage|Model|Guards|▸|▾/)).toBe(false)
  expect(await has(ui, /beneath/)).toBe(true)
  expect((await $.command.run({ command: 'guards', args: 'show' })).text).toBe('guards: shown')
  expect(await has(ui, /^Usage$/)).toBe(true)
  await ui.unmount()
})

test('after a restart the usage row shows the last stored reading before the first reply', async ($, on) => {
  // A stored reading from earlier (the week at 30%, resetting in 4 days), and no reading yet this session.
  engine(on, undefined, undefined, { lastWeek: { pct: 30, resetsAt: NOW + 4 * D } }, [])
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await has(ui, /^Today \d+%$/)).toBe(true)
  expect(await has(ui, /shows after the first reply/)).toBe(false)
  await ui.unmount()
})

test('the line under the row says where today stands with the days before it', async ($, on) => {
  // The week reset 3 days ago at Sunday noon; 30% used, 10% of it today: earlier days left +15.7%.
  engine(on, undefined, undefined, { days: { '2026-10-28': { used: 10 } }, lastWeek: { pct: 30, resetsAt: NOW + 4 * D }, seeded: true }, [
    { kind: 'seven_day', percentUsed: 30, resetsAt: new Date(NOW + 4 * D).toISOString() },
  ])
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await has(ui, /^\+16% saved from earlier days: today has 30% of the weekly limit instead of 14%\.$/)).toBe(true)
  await ui.unmount()
})

test('a switch in the desktop menu shows within two seconds, with no keystroke', async ($, on) => {
  const clock = engine(on, '{"kind":"architecture","scope":"medium","ambiguity":"low","risk":"low","topic":"related","why":"data model design"}')
  // The desktop app's state file for this session, which its menu writes.
  const file = { text: JSON.stringify({ sessionId: 'sess-1', model: 'claude-opus-5-5', effort: 'high' }), mtimeMs: 1 }
  const root = 'C:\Local\Claude-Data'
  on('env.get', () => ({ value: 'C:\Local' }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('fs.list', (_, e) => {
    const path = String(e.path)
    const dir = (name: string) => ({ name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false })
    if (path === root) return { value: [dir('claude_x')] }
    if (path.endsWith('claude-code-sessions')) return { value: [dir('a')] }
    if (path.endsWith('\a')) return { value: [dir('b')] }
    return { value: [{ name: 'local_1.json', kind: 'file', size: 10, mtimeMs: file.mtimeMs, isLink: false }] }
  })
  on('fs.exists', () => ({ value: true }))
  on('fs.read', () => ({ value: file.text }))
  on('fs.stat', () => ({ value: { kind: 'file', size: 10, mtimeMs: file.mtimeMs, isLink: false } }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.change({ text: 'design the data model for the new billing area', cursor: 0, origin: { kind: 'history' } })
  await clock.advance(1500)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await has(ui, /Set effort to/)).toBe(true)

  // The menu switches to the advised effort: the row follows on the next look.
  file.text = JSON.stringify({ sessionId: 'sess-1', model: 'claude-opus-5-5', effort: 'medium' })
  file.mtimeMs = 2
  await clock.advance(2500)
  expect(await has(ui, /✓ fits/)).toBe(true)
  await ui.unmount()
})

test('a state file that appears after the chat starts is still found', async ($, on) => {
  const clock = engine(on, '{"kind":"architecture","scope":"medium","ambiguity":"low","risk":"low","topic":"related","why":"data model design"}')
  const file = { exists: false, text: JSON.stringify({ sessionId: 'sess-1', model: 'claude-opus-5-5', effort: 'high' }), mtimeMs: 1 }
  const root = 'C:\Local\Claude-Data'
  on('env.get', () => ({ value: 'C:\Local' }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('fs.list', (_, e) => {
    const path = String(e.path)
    const dir = (name: string) => ({ name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false })
    if (path === root) return { value: [dir('claude_x')] }
    if (path.endsWith('claude-code-sessions')) return { value: [dir('a')] }
    if (path.endsWith('\a')) return { value: [dir('b')] }
    return { value: file.exists ? [{ name: 'local_1.json', kind: 'file', size: 10, mtimeMs: file.mtimeMs, isLink: false }] : [] }
  })
  on('fs.exists', () => ({ value: true }))
  on('fs.read', () => ({ value: file.text }))
  on('fs.stat', () => ({ value: { kind: 'file', size: 10, mtimeMs: file.mtimeMs, isLink: false } }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.change({ text: 'design the data model for the new billing area', cursor: 0, origin: { kind: 'history' } })
  await clock.advance(1500)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  // The app writes the file now, at medium: within the next look-up the row follows.
  file.exists = true
  file.text = JSON.stringify({ sessionId: 'sess-1', model: 'claude-opus-5-5', effort: 'medium' })
  await clock.advance(17_000)
  expect(await has(ui, /✓ fits/)).toBe(true)
  await ui.unmount()
})

test('while a turn runs the row says it is paused, and the full check runs when the turn ends', async ($, on) => {
  const calls = { n: 0 }
  const clock = engine(on, '{"kind":"architecture","scope":"medium","ambiguity":"low","risk":"low","topic":"related","why":"data model design"}', calls)
  on('turn.step', async function* () {
    return { turnId: 't1', index: 0, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  on('turn.complete', (_, e) => ({ text: e.answer }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', effort: 'medium', messageCount: 1 })) void _
  await $.prompt.change({ text: 'design the data model for the new billing area', cursor: 0, origin: { kind: 'history' } })
  await clock.advance(3000)
  expect(calls.n).toBe(0)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await has(ui, /paused while Claude works/)).toBe(true)
  await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.advance(1500)
  expect(calls.n).toBe(1)
  expect(await has(ui, /paused while Claude works/)).toBe(false)
  expect(await has(ui, /Opus · medium/)).toBe(true)
  await ui.unmount()
})

