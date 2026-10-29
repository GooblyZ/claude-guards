import { expect, test } from 'claude-code/testing'

import { budget, decide, needOf, type Features } from '../hooks/model-logic'

// The policy's evaluation set: typical tasks, described as the reader would describe them,
// and what RESEARCH.md says each should get, in a fresh chat on a calm week. A change to the
// policy that moves one of these has to say why.

const NOW = Date.parse('2026-10-28T12:00:00')
const CALM = [{ kind: 'seven_day', percentUsed: 20, resetsAt: new Date(NOW + 4 * 24 * 3_600_000).toISOString() }]

const base: Features = {
  kind: 'edit',
  scope: 'small',
  ambiguity: 'low',
  risk: 'low',
  topic: 'new',
  deepReasoning: false,
  priorFailures: false,
  longRunning: false,
  why: '',
}

const CASES: [string, Partial<Features>, string][] = [
  ['fix a typo in the README', { kind: 'trivial', scope: 'tiny' }, 'haiku·low'],
  ['what does this error mean?', { kind: 'question', scope: 'tiny' }, 'haiku·low'],
  ['commit and push', { kind: 'ops', scope: 'tiny' }, 'haiku·low'],
  ['change the button colour', { kind: 'edit', scope: 'tiny' }, 'haiku·low'],
  ['write five ad headlines', { kind: 'edit', scope: 'small' }, 'sonnet·low'],
  ['create five realistic images of a bodybuilder', { kind: 'content', scope: 'small' }, 'sonnet·medium'],
  ['produce a full ad campaign: scripts, visuals, variants', { kind: 'content', scope: 'large', ambiguity: 'medium' }, 'sonnet·medium'],
  ['add an export button (clear spec, a few files)', { kind: 'feature', scope: 'medium' }, 'sonnet·medium'],
  ['fix this off-by-one in one function', { kind: 'bugfix', scope: 'tiny' }, 'sonnet·medium'],
  ['fix the failing checkout test', { kind: 'bugfix', scope: 'small' }, 'sonnet·high'],
  ['compare these two libraries for us', { kind: 'research', scope: 'medium', ambiguity: 'medium' }, 'sonnet·medium'],
  ['rename and split the services module across the codebase', { kind: 'refactor', scope: 'large' }, 'opus·medium'],
  ['design the data model for the new billing area', { kind: 'architecture', scope: 'medium' }, 'opus·medium'],
  ['why is this test flaky? it passes locally', { kind: 'bugfix', ambiguity: 'high', deepReasoning: true }, 'opus·high'],
  ['harden the login against session fixation', { kind: 'bugfix', risk: 'high' }, 'opus·high'],
  ['build the whole game: physics, AI, multiplayer', { kind: 'feature', scope: 'large', ambiguity: 'medium', deepReasoning: true, longRunning: true }, 'opus·xhigh'],
  ['research the market, sources to a finished report', { kind: 'research', scope: 'large', ambiguity: 'medium', deepReasoning: true, longRunning: true }, 'fable·low'],
  ['redesign the platform from a vague brief, over days', { kind: 'architecture', scope: 'large', ambiguity: 'high', deepReasoning: true, longRunning: true }, 'fable·xhigh'],
]

test('the evaluation set: each typical task gets what the research says', async () => {
  const misses: string[] = []
  for (const [name, over, want] of CASES) {
    const rec = decide(needOf({ ...base, ...over }), name, 'haiku', { budget: budget(CALM, NOW), costs: {} })
    const got = `${rec.model}·${rec.effort}`
    if (got !== want) misses.push(`${name}: got ${got}, want ${want}`)
  }
  expect(misses).toEqual([])
})
