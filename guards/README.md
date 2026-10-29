# claude-guards

One Claude Code mod, `guards`, that adds a foldable block above the prompt box
with two guards in it, Usage and Model. Each has its own switch, so either runs
alone, both run, or neither; the main switch at the top right turns them all off,
leaving one small "Guards off" line whose switch turns them back on. `▾` folds the block, `▸` opens it.
`/guards off` and `/guards on` do the same as the main switch.
The `✕` hides the block in the current chat alone; `/guards show` brings it back.

## usage-guard: where today stands against an even week

- **An even week, carried day to day.** An even week is 100% of the weekly
  limit over 7 days, about 14.3% a day. Today's allowance is where an even week
  stands at midnight tonight, less what you used before today: what earlier days
  left unused is added (`+3.7% from earlier days`), what they overdrew is taken.
- **The row:** `Today X% of Y%` with a bar that fills toward the allowance; on
  desktop a tick marks where today would be by now on an even pace.
- **Going past it is fine.** It says `past today's allowance` and that the days
  ahead get a little less. Red only when what's left would give the days ahead
  under half an even day each.
- **Below the row:** the week against an even split by now, and what the time
  left has per day.
- `/usage-guard` opens a pane with the week, today and the last 14 days.

No tokens: every figure is Anthropic's own reading, in 0.1% steps.

## model-guard: which model does this prompt need?

While you type, it suggests a model and effort and compares it with what's
running: `Opus · medium ✓ fits`, `Try Sonnet · medium`, or `Consider Opus · high`.

- **Haiku describes, the policy decides.** 1.2 seconds after you stop typing,
  one short Haiku call reads the draft, the session's first ask and the last few
  messages, and fills fixed fields: kind of task, scope, ambiguity, risk, whether
  it continues earlier work or starts a new topic, whether it needs deep
  reasoning, whether it already failed. Haiku never picks the model.
- **Two axes.** The policy turns that into what the work needs: a model tier
  (Haiku, Sonnet, Opus, Fable) and an effort (low to max). Ordinary Opus work
  runs at medium; high needs deep reasoning or a vague goal; xhigh and max need
  more; Fable is kept for deep work at scale that is vague or already failed.
- **Cheapest option that meets it.** A stronger model one effort lower counts
  as meeting the need, so Opus · medium can stand in for Sonnet · high when it
  costs you less. Costs are your own: every turn records what it took from your
  weekly limit under its model and effort, on or off. Until a model and effort
  has three turns, a starting estimate stands in, scaled to what was measured.
- **Follow-ups stay put.** In a conversation past 40k tokens, a light follow-up
  stays on the running model at low effort: a switch re-reads the whole context
  without the cache, and the new model starts without what the running one
  worked out. A new topic is told to /clear first.
- **Your budget counts, but only what is certain.** A 5-hour window past 85%,
  or today past its allowance, steps the advice down; so does a week that is
  already running short. A forecast of the week does not: days you don't use
  Claude would make it wrong.

Each Haiku check costs about 1.5k Haiku tokens; drafts under 20 characters,
follow-ups and drafts already checked skip it. `/model-guard local` keeps the
keyword rules alone (no tokens), `/model-guard smart` brings the check back,
and `/model-guard` prints the last advice with what was needed and why, your
measured cost per model and effort, and what the Haiku checks have cost.

It never sends, blocks or switches anything: `/model` and `/effort` stay yours.

## Install

From a GitHub repository holding this folder:

```
/plugin install guards --marketplace <owner>/<repo>
```

Or from a local folder (Windows example), in `%USERPROFILE%\.claude\settings.json`:

```json
{ "env": { "CLAUDE_CODE_PLUGIN_DIRS": "C:\\Users\\<you>\\claude-mods\\claude-guards\\guards" } }
```

## Tuning

model-guard's policy is in `guards/hooks/model-logic.ts`: `BASE`, `SCOPE`,
`HIGHER`, `levelFor` and `budget`; Haiku's instructions are `SYSTEM`.
usage-guard's weekly target is `TARGET` in `guards/hooks/usage-logic.ts`.
