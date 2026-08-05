# Exact Today Usage Implementation Plan

**Goal:** Prevent historical DeepSeek usage from being displayed as today's cost, tokens, or cache metrics when the local calendar day has no record.

**Architecture:** Keep monthly totals and historical `dailyData` unchanged. Replace the current last-entry fallback used for `today*` fields with an exact lookup of `localTodayStr()`. Month fallback continues returning prior-month totals and daily history, but its `today*` aggregates remain zero unless the returned data genuinely contains the current local date.

## Task 1: Establish RED

- Add a historical-only cost and token payload test.
- Require all `today*` aggregates to be zero while totals and daily history remain intact.
- Add a current-month-empty fallback test whose previous month has historical usage.
- Require fallback totals to remain available without contaminating `today*` fields.
- Keep a zero-input current-day cache-rate assertion.
- Create a Draft PR and record the expected failures before production changes.

## Task 2: Implement GREEN

- Replace the fallback-to-last-day helper with an exact local-today lookup.
- Reuse that helper in cost and token parsing.
- Do not alter monthly totals, model totals, daily history, or fallback month selection.
- Run the complete test suite, renderer build, and Electron/Xvfb smoke test.
- Review the final diff, confirm zero unresolved review threads, update PR evidence, mark ready, and squash merge using the verified head SHA.

## Semantics and scope

`today*` means the user's current local calendar date only. Absence of that date is zero, not the latest available date. This issue does not change the historical graph, month fallback policy, timezone implementation, or yesterday calculations.
