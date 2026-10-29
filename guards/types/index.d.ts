export type Window = { pct: number; resetsAt?: number }

/** One calendar day: weekly-% points spent. */
export type Day = { used: number }

/** Where the week stands against an even split of the limit. */
export type Pace = {
  /** Where an even week (100% over 7 days) would be by now. */
  expected: number
  /** Where the week ends at its pace so far. */
  projected?: number
  /** Today's allowance: an even day (100 / 7) plus what earlier days left, or less what they overdrew. Tracked, not a cap. */
  todayBudget: number
  /** Where today would be by now on an even pace, the carry included. */
  todayUsual: number
  /** What earlier days left (+) or overdrew (−) against an even week. */
  carry: number
  /** What's left of the limit, spread over the time left until the reset, per day. */
  restDaily?: number
}

export type Meter = {
  five?: Window
  week?: Window
  todayUsed: number
  pace?: Pace
}

/** What this session alone has taken from the limits since it started. */
export type Sess = {
  startedAt: number
  week: number
  five: number
  lastWeek?: number
  lastFive?: number
  lastFiveReset?: number
}

/**
 * What a task needs: `tier` of model (1 Haiku, 2 Sonnet, 3 Opus, 4 Fable)
 * and `depth` of effort (0 low, 1 medium, 2 high, 3 xhigh, 4 max).
 */
export type Need = { tier: number; depth: number }

/**
 * A suggestion, from the local rules alone (`local`) or from Haiku's
 * description of the task (`haiku`), with the need it was chosen for.
 */
export type Rec = {
  model: string
  effort: string
  need: Need
  /** The short reason, a few words. */
  why: string
  /** Longer notes for the line below: budget, staying on the model, a new topic. */
  notes: string[]
  source: 'local' | 'haiku'
  /** The kind of task the advice was for, as Haiku described it, or `local`. */
  kind?: string
  /** Haiku couldn't tell what the draft asks: no advice is shown. */
  isUnclear?: true
}

export type Actual = { model: string; effort?: string | number }

/** What the Haiku checks have cost, all sessions together. */
export type Spent = { calls: number; input: number; output: number }

/** What your own turns on one model and effort took from the weekly limit. */
export type Cost = { turns: number; week: number }

/** What one guard's row in the block says, worked out before drawing. */
export type GuardRow = {
  name: string
  isOn: boolean
  flip: () => Promise<void>
  /** The headline, coloured by `tone`; empty when the row has only a note. */
  text: string
  tone?: string
  note: string
  /** A plain sentence for the line below, when there is more to say. */
  extra: string
  /** What the folded block says for this guard. */
  brief: string
  /** A bar to draw after the headline: spent against a cap, a tick where a usual day would be. */
  /** Work under way: the row draws a small pulse beside its note. */
  isBusy?: boolean
  bar?: { used: number; cap: number; usual?: number; tone: 'success' | 'warning' | 'error' }
}

declare module 'claude-code' {
  interface PluginState {
    guards: {
      /** The whole feature: off hides the block and stops its work in every chat. */
      isEnabled: boolean
      /** Hidden in this chat alone (/guards hide, or the ✕). */
      isHidden: boolean
      /** Whether the block is unfolded. */
      isOpen: boolean
      meter: Shaped<Meter | null>
      session: Shaped<Sess | null>
      usageOn: boolean
      draft: Shaped<Rec | null>
      last: Shaped<Rec | null>
      actual: Shaped<Actual | null>
      modelOn: boolean
      isSmart: boolean
      isChecking: boolean
    }
  }
}
