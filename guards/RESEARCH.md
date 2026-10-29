# What model-guard's policy rests on

Gathered 2026-10-28 for Claude Code on the Anthropic API or a Claude subscription,
models of the 5.5 generation. Every rule in `hooks/model-logic.ts` points back to a
numbered finding here. Primary sources (Anthropic's own docs) are marked **[A]**;
third-party reports are marked **[3]** and used only where nothing official exists.

## The models

1. **Opus 5.5 is the starting point.** "If you're unsure which model to use, start
   with Claude Opus 5.5 for most workloads." Fable 5.1 is "for demanding reasoning
   and long-horizon agentic work, or when your evals on Claude Opus 5.5 at higher
   effort still fall short." **[A]** [Models overview][overview]
2. **The selection matrix.** **[A]** [Choosing a model][choosing]
   - Fable 5.1: agent sessions that run for hours, multistep deep research, analysis
     carried through to a finished document.
   - Opus 5.5: multihour autonomous coding, large-scale refactoring, complex systems
     engineering.
   - Sonnet 5.5: code generation, data analysis, content creation, agentic tool use.
   - Haiku 5.5: real-time and high-volume work, subagent tasks; on the overview page,
     "classification, extraction, and routing".
3. **Move to Fable only after Opus at xhigh or max falls short.** "If your evals at
   `xhigh` or `max` effort still fall short on demanding reasoning or long-horizon
   agentic work, move to Claude Fable 5.1." **[A]** [Choosing a model][choosing]
4. **Smaller for routine, larger for ambiguous.** "Choose smaller models for more
   routine tasks and larger models for more complex or ambiguous tasks." Smaller models
   suit precisely described edits, mechanical changes, and questions about code already
   in context. Fable pulls ahead on long multi-step work Opus and Sonnet could not
   finish at any effort. **[A]** [Choosing a model and effort level in Claude Code][cc-blog]
5. **Know vs try.** "Did it not *try* hard enough, or did it not *know* enough?" Cut
   corners (skipped a file, didn't run tests) → raise effort. Had the context, tried,
   still wrong → larger model. **[A]** [same post][cc-blog]
6. **Prices per million tokens (input/output):** Fable 5.1 $10/$50, Opus 5.5 $4/$20,
   Sonnet 5.5 $2/$10, Haiku 5.5 from $0.10/$0.50. Cache reads: 5% of input on
   Opus and Sonnet 5.5, 2.5% on Fable 5.1. **[A]** [Models overview][overview]
7. **Fable may not draw on plan limits.** "Depending on your plan and seat tier,
   Fable usage can bill to usage credits instead of drawing on your plan's included
   limits"; the `/model` picker then says "Requires usage credits". **[A]** [Model config][cc-model]

## Effort

8. **What each level is for, in Claude Code.** **[A]** [Model config][cc-model]
   - `low`: "Quick exchanges where you review each result, such as brainstorming, a
     first sketch, or a small change like a rename".
   - `medium`: the default on Opus 5.5, Sonnet 5.5, Haiku 5.5; "day-to-day engineering
     work with a clear scope".
   - `high`: "Work where verification matters or edge cases are likely, such as fixing
     a bug in an existing codebase".
   - `xhigh`: "Deeper reasoning at higher token spend". The API docs: "Long-running
     agentic and coding tasks (over 30 minutes) with token budgets in the millions".
     **[A]** [Effort][effort]
   - `max`: "Hard problems you want Claude to work through without you, such as finding
     security vulnerabilities. `max` may show diminishing returns and is prone to
     overthinking".
9. **Default effort first.** "For most tasks you should use the model's default
   effort level", set "as a general preference than a task-by-task decision".
   **[A]** [cc-blog]
10. **Measured effort trade-off, Opus 5.5 on SWE-bench Pro:** `low` 87.4% at $0.11,
    `medium` 92.8% at $0.21, `high` 95.3% at $0.29 per task. Sonnet 5.5 at `medium`
    scored about 7 points below `high` for about 59% of the cost. **[A]**
    [Optimizing for cost and intelligence][optimizing]
11. **Opus low ≈ Sonnet at its default.** Opus 5.5 at `low` matched Sonnet 5.5 at its
    default (`high`) on SWE-bench Pro, 87.4% vs 87.6%, for about 7% more per solved
    task. **[A]** [optimizing]
12. **Haiku for checkable volume.** Haiku 5.5 scored 85% on GPQA Diamond vs 91% for
    Opus and Sonnet 5.5, at about a twentieth of Opus 5.5's cost per correct answer.
    **[A]** [optimizing]
13. **Effort doesn't always buy quality.** Fable 5.1 on DeepResearch Bench II scored
    66% at `low` and 65% at `high`. **[A]** [optimizing]
14. **Start low, retry on failure.** Running at `low` and re-running only failures at
    `high` solved about 97% for $0.17 per task, vs 95.3% for $0.29 with everything at
    `high`; this needs a reliable failure signal. **[A]** [optimizing]

## The cache, mid-session

15. **A model switch re-reads everything.** "Each model has its own cache. Switching
    with `/model` means the next request reads the entire conversation history with no
    cache hits." **[A]** [Prompt caching in Claude Code][cc-cache]
16. **An effort change doesn't, on the 5.5 models.** "On Opus 5.5, Sonnet 5.5,
    Haiku 5.5, and Fable 5.1 with an API key or a Claude subscription, changing effort
    keeps the cache, and Claude Code applies the new level without asking."
    **[A]** [cc-cache]

## Benchmarks between the models (third-party reports of launch tables)

17. Sonnet 5.5 leads Terminal-Bench 4.0 (70.6% vs Opus 5.5's 66.4% at xhigh); Opus 5.5
    leads SWE-Bench Pro by a few points; most scoped coding work is within a few points.
    **[3]** [the-decoder][decoder], [emergent][emergent]. Figures vary between reports;
    used only as "Sonnet is close to Opus on scoped coding", which [10]–[11] confirm.

## What is not known

- **How each model counts against Max plan limits.** Anthropic publishes no per-model
  weighting; third-party estimates disagree. model-guard therefore measures it: each
  turn records what it took from your weekly limit under its model and effort.
- **xhigh and max costs on Opus 5.5, and any Fable cost per task.** Not published. The
  policy's starting estimates for them are scaled from token prices and marked as such;
  your own measurements replace them once there are enough turns.
- **Whether a given prompt needs a given model.** Benchmarks give averages over task
  types, never a verdict on one prompt. The policy maps task types to models from the
  findings above; Haiku only reads which type a prompt is.

## How the policy uses this

| Rule in the policy | Findings |
| --- | --- |
| Opus · medium is the anchor for ordinary engineering work | 1, 8, 9 |
| Sonnet reads every draft (a check costs about half a cent at list prices; a misrouted Opus turn about 21 cents) | 6, 10 |
| Sonnet for clearly specified code, content, data work; Haiku for questions, lookups, mechanical edits in a small or fresh chat | 2, 4, 12 |
| `high` for bug fixes in existing code, risk, or a vague goal | 8 |
| `xhigh` only for work expected to run long (over ~30 minutes) | 8 |
| `max` only for deep reasoning that already failed at a lower level | 3, 8, 14 |
| Fable only for hours-long deep research or open-ended design, or after Opus fell short; long autonomous coding stays on Opus | 1, 2, 3 |
| A stronger model one effort lower meets the same need (Opus low ≈ Sonnet high) | 11 |
| Mid-session, change effort rather than model | 15, 16 |
| A miss after a turn: "wrong" raises the model, "cut corners" raises effort | 5, 14 |
| Fable carries a note that it may bill to usage credits | 7 |
| Cost estimates per option (relative): from 6, 10, 11, 12 | 6, 10–12 |

[overview]: https://platform.claude.com/docs/en/about-claude/models/overview
[choosing]: https://platform.claude.com/docs/en/about-claude/models/choosing-a-model
[effort]: https://platform.claude.com/docs/en/build-with-claude/effort
[optimizing]: https://platform.claude.com/docs/en/about-claude/models/optimizing-for-cost-and-intelligence
[cc-model]: https://code.claude.com/docs/en/model-config
[cc-cache]: https://code.claude.com/docs/en/prompt-caching
[cc-blog]: https://claude.com/resources/articles/claude-model-and-effort-level-in-claude-code
[decoder]: https://the-decoder.com/anthropics-claude-sonnet-5-5-nearly-matches-opus-5-5-on-benchmarks-while-costing-up-to-30-percent-less-per-task/
[emergent]: https://emergent.sh/learn/claude-sonnet-5-5-benchmarks
