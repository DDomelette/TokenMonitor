# Balance Currency Formatting Implementation Plan

**Goal:** Render DeepSeek balance amounts with the currency supplied by the API instead of always labeling them as CNY.

**Architecture:** Add a pure renderer money formatter used only by the balance card. Known currencies map to unambiguous common symbols; unmapped valid ISO codes are shown as an uppercase code. The formatter preserves supplied numeric text, treats zero as present, and uses `--` only for null, undefined, or empty values. Total, topped-up, and granted balances all use the same function.

## Task 1: Establish RED

- Add CNY, USD, and another known-currency symbol test.
- Add an unknown ISO currency code test.
- Add numeric zero and string zero tests.
- Add missing-value behavior tests.
- Add a source guard requiring `FeeCard.jsx` to use the formatter for total, topped-up, and granted values without `|| '--'` fallback.
- Create a Draft PR and record RED while all existing tests remain green.

## Task 2: Implement GREEN

- Add a pure `fee-card-money.mjs` formatter.
- Import it into `FeeCard.jsx` and format all three balance amounts consistently.
- Keep balance threshold coloring and non-balance cards unchanged.
- Run the complete test suite, renderer build, and Electron/Xvfb smoke test.
- Review the final diff, confirm zero unresolved review threads, update PR evidence, mark ready, and squash merge using the verified head SHA.

## Semantics and scope

A valid but unmapped three-letter currency is displayed as `CODE amount`. Missing or malformed currency does not invent a symbol. Amount text is not rounded or localized in this issue. Only the balance card changes; the usage cost card continues using its existing business currency presentation.
