import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { GuardRow } from '../types'
import { modelMeasure, modelRow, modelStart, modelTurnDone, registerModel } from './model'
import { registerUsage, usageMeasure, usageRow, usageStart, usageTurnDone } from './usage'
import { capSvg } from './usage-logic'

const openAtom = atom({ plugin: 'guards', key: 'isOpen' } as const, true)
const enabledAtom = atom({ plugin: 'guards', key: 'isEnabled' } as const, true)
// This chat alone: the session's state, never the store, so other chats keep the block.
const hiddenAtom = atom({ plugin: 'guards', key: 'isHidden' } as const, false)

const setOpen = async ($: EngineInterface, isOpen: boolean) => {
  await update($, openAtom, () => isOpen)
  await $.store.set('isOpen', isOpen)
}

/** The main switch: off stops all the work and folds the block to its arrow; on opens it again. */
const setEnabled = async ($: EngineInterface, isEnabled: boolean) => {
  await update($, enabledAtom, () => isEnabled)
  await $.store.set('isEnabled', isEnabled)
  await setOpen($, isEnabled)
}

/** The block's colours: softer than the theme's own, one per meaning. */
const PALETTE: Record<string, string> = {
  success: '#5DCAA5',
  warning: '#EF9F27',
  error: '#E24B4A',
  claude: '#E07A55',
  suggestion: '#85B7EB',
}
const paint = (tone?: string) => (tone ? PALETTE[tone] ?? tone : undefined)

/** A switch like the app's own: a blue track with the knob right when on, grey with it left when off. */
const switchSvg = (isOn: boolean) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="15" viewBox="0 0 28 15"><rect width="28" height="15" rx="7.5" fill="${isOn ? '#378ADD' : '#5f5e5a'}"/><circle cx="${isOn ? 20.5 : 7.5}" cy="7.5" r="5.5" fill="#ffffff"/></svg>`

export const register: Register = on => {
  registerUsage(on)
  registerModel(on)

  // A plugin hooks each event once: these three serve both guards.
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    if ((await $.store.get('isOpen')) === false) await update($, openAtom, () => false)
    if ((await $.store.get('isEnabled')) === false) await update($, enabledAtom, () => false)
    await $.command.register({
      name: 'guards',
      description: 'Turn all the guards off or on, in every chat (the same as the main switch)',
      argumentHint: '[on|off|hide|show]',
    })
    // The figures live in the block alone: clear a line an earlier version left below the prompt.
    $.ui.status(undefined)
    await usageStart($, e)
    await modelStart($, e)
    return started
  })

  // The whole feature: off folds the block to its arrow and stops all its work, in every chat.
  on('command.run', { command: 'guards' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'hide' || arg === 'show') {
      await update($, hiddenAtom, () => arg === 'hide')
      return { text: arg === 'hide' ? 'guards: hidden in this chat. /guards show brings it back.' : 'guards: shown' }
    }
    if (arg !== 'on' && arg !== 'off') {
      return { text: `guards: ${(await read($, enabledAtom)) ? 'on' : 'off'}. /guards on|off for every chat, /guards hide|show for this chat alone.` }
    }
    const isEnabled = arg === 'on'
    await setEnabled($, isEnabled)
    return { text: isEnabled ? 'guards: on' : 'guards: off in every chat. /guards on brings it back.' }
  })

  on('session.measure', async ($, e, next) => {
    await usageMeasure($, e)
    await modelMeasure($, e)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    await usageTurnDone($, e)
    await modelTurnDone($, e)
    return done
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, hiddenAtom))) return next(e)
    const below = await next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    try {
      const isEnabled = await read($, enabledAtom)
      const isOpen = await read($, openAtom)

      // A switch is the one thing that takes a click: drawn on desktop with a clear
      // button laid over it, in words on the terminal.
      const toggle = (key: string, label: string, isOn: boolean, flip: () => Promise<void>) => {
        if (e.surface === 'desktop') {
          const { Svg } = $.ui.resolve(e)
          return (
            // One text line tall, the switch centred in it, so it sits level with the words beside it.
            <Box position="relative" width={4} height={1} flexShrink={0} alignItems="center" overflow="hidden">
              <Svg source={switchSvg(isOn)} alt={`${label} ${isOn ? 'on' : 'off'}`} width={28} height={15} />
              <Box position="absolute" top={0} left={0}>
                <Button key={key} plain label="⠀⠀⠀" onPress={flip} />
              </Box>
            </Box>
          )
        }
        return (
          <Button key={key} plain onPress={flip}>
            <Text color={isOn ? 'suggestion' : undefined} dimColor={!isOn}>
              {isOn ? '━●' : '●━'}
            </Text>
          </Button>
        )
      }

      // Today's spend against its cap: drawn on desktop, in blocks on the terminal.
      const bar = (name: string, b: NonNullable<GuardRow['bar']>) => {
        if (e.surface === 'desktop') {
          const { Svg } = $.ui.resolve(e)
          return (
            <Box flexShrink={0}>
              <Svg source={capSvg(b.used, b.cap, b.usual, b.tone)} alt={`${name}: ${Math.round(b.used * 10) / 10}% of ${Math.round(b.cap * 10) / 10}%`} width={72} height={10} />
            </Box>
          )
        }
        const cells = Math.round(Math.min(1, b.cap > 0 ? b.used / b.cap : 1) * 6)
        return <Text color={paint(b.tone)}>{'▰'.repeat(cells) + '▱'.repeat(6 - cells)}</Text>
      }

      // Three dots that pulse in turn while a check runs: animated SVG on desktop, an ellipsis elsewhere.
      const busy = () => {
        if (e.surface !== 'desktop') return <Text dimColor>…</Text>
        const { Svg } = $.ui.resolve(e)
        const dot = (cx: number, begin: string) =>
          `<circle cx="${cx}" cy="4" r="2.5" fill="#378ADD"><animate attributeName="opacity" values="0.25;1;0.25" dur="1s" begin="${begin}" repeatCount="indefinite"/></circle>`
        const source = `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="8" viewBox="0 0 22 8">${dot(3, '0s')}${dot(11, '0.2s')}${dot(19, '0.4s')}</svg>`
        return (
          <Box flexShrink={0} alignItems="center">
            <Svg source={source} alt="checking" width={22} height={8} isInteractive />
          </Box>
        )
      }

      const fold = (
        <Button key="guards-fold" plain onPress={() => setOpen($, !isOpen)}>
          <Text>{isOpen ? '▾' : '▸'}</Text>
        </Button>
      )
      const hide = (
        <Button key="guards-hide" plain onPress={() => update($, hiddenAtom, () => true)}>
          <Text dimColor>✕</Text>
        </Button>
      )

      // Off: one small line, its switch and "Guards off"; the ✕ closes even that in this chat.
      if (!isEnabled) {
        return (
          <Box flexDirection="column">
            <Box alignItems="center" gap={1}>
              {toggle('guards-main-switch', 'Guards', false, () => setEnabled($, true))}
              <Text dimColor>Guards off</Text>
              {hide}
            </Box>
            {below}
          </Box>
        )
      }

      const rows = [await usageRow($), await modelRow($)]
      // Folded: each guard's headline in its colour, the usage bar beside it, on one line.
      const shown = rows.filter(r => r.isOn && r.text)
      const folded = (
        <Box alignItems="center" gap={1} flexShrink={1} minWidth={0}>
          {shown.map((r, i) => (
            <Box key={`guards-${r.name.toLowerCase()}-brief`} alignItems="center" gap={1}>
              {i > 0 && <Text dimColor>·</Text>}
              <Text color={paint(r.tone)} weight="semibold">
                {r.text}
              </Text>
              {r.bar && bar(r.name, r.bar)}
            </Box>
          ))}
        </Box>
      )

      // The top line: the arrow, what the folded block says, and the main switch at the right.
      const header = (
        <Box alignItems="center" gap={1}>
          {fold}
          <Box flexGrow={1} flexShrink={1} minWidth={0}>
            {!isOpen && folded}
          </Box>
          <Text dimColor>Guards</Text>
          {toggle('guards-main-switch', 'Guards', isEnabled, () => setEnabled($, !isEnabled))}
          {hide}
        </Box>
      )

      if (!isOpen) {
        return (
          <Box flexDirection="column">
            {header}
            {below}
          </Box>
        )
      }

      return (
        <Box flexDirection="column" rowGap="xs">
          {header}
          {rows.map(r => (
            <Box key={`guards-${r.name.toLowerCase()}-row`} alignItems="flex-start" gap={1}>
              {toggle(`guards-${r.name.toLowerCase()}-switch`, r.name, r.isOn, r.flip)}
              <Box width={8} flexShrink={0}>
                <Text dimColor={!r.isOn}>{r.name}</Text>
              </Box>
              {/* The advice heads its own column: a note below starts under it. */}
              <Box flexDirection="column" flexShrink={1} minWidth={0}>
                <Box alignItems="center" gap={1}>
                  {r.text && (
                    <Text color={paint(r.tone)} weight="semibold">
                      {r.text}
                    </Text>
                  )}
                  {r.isBusy && busy()}
                  {r.bar && bar(r.name, r.bar)}
                  <Box flexShrink={1} minWidth={0}>
                    <Text dimColor wrap="truncate-end">
                      {r.note}
                    </Text>
                  </Box>
                </Box>
                {/* Each note is a sentence of its own, on its own line. */}
                {r.extra
                  .split(/(?<=\.)\s+/)
                  .filter(Boolean)
                  .map(line => {
                    // The lighter option names its model in bold, so it reads as a second choice.
                    const lighter = line.match(/^(Lighter option: )([^,]+)(,.*)$/)
                    return lighter ? (
                      <Text dimColor size="footnote">
                        {lighter[1]}
                        <Text weight="semibold">{lighter[2]}</Text>
                        {lighter[3]}
                      </Text>
                    ) : (
                      <Text dimColor size="footnote">
                        {line}
                      </Text>
                    )
                  })}
              </Box>
            </Box>
          ))}
          {below}
        </Box>
      )
    } catch (error) {
      // Better a line that says what broke than a block that silently isn't there.
      return (
        <Box flexDirection="column">
          <Text color="warning">guards: {error instanceof Error ? error.message : String(error)}</Text>
          {below}
        </Box>
      )
    }
  }).catch(async ($, e) => {
    // The engine refused the drawing itself: show the plain-text block instead.
    const { Box, Text } = $.ui.resolve(e)
    const rows = [await usageRow($), await modelRow($)]
    return (
      <Box flexDirection="column">
        <Text dimColor>Guards (simple view)</Text>
        {rows.map(r => (
          <Text>
            {r.name}: {r.text ? `${r.text} · ` : ''}
            {r.note}
          </Text>
        ))}
      </Box>
    )
  })
}
