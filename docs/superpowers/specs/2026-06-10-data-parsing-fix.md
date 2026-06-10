# Data Parsing Fix — 2026-06-10

## Root Cause

The two DeepSeek platform APIs return `biz_data` in **different shapes**:

| API | biz_data type | Structure |
|-----|:---:|------|
| `/api/v0/usage/cost` | Array | `[{ total: [...], days: [...] }]` |
| `/api/v0/usage/amount` | Object | `{ total: [...], days: [...] }` |

`parseDailyData(bizData)` assumed `bizData[0].days` (array access), which failed for the amount API → all token data returned as empty/zero.

## Fix

```
Before:  var root = bizData[0];              // ❌ undefined for amount API
After:   var root = Array.isArray(bizData) ? bizData[0] : bizData;  // ✅
```

Applied to both `parseCostData` and `parseTokenData`.

## Verified Data

```
cost:  ¥123.45
token: 123,456,789 (123M)
daily: 30 entries (6/1 ~ 6/30)
```
