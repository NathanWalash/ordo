# Money

## Finances charts

The Finances page answers four questions at a glance. Every chart follows the **Account** filter;
the monthly charts ignore the **Month** filter (they always show every month) and highlight the
chosen month instead.

```
[Account] [Month]                                [Sort with AI] [Import statement]
[ Money in ]        [ Money out ]       [ Net ]
┌ Money in and out ─────────────────────────────────── ▮ In  ▮ Out  ● Net ┐
│  money in above the line, money out below, a dot for net, per month       │
└───────────────────────────────────────────────────────────────────────────┘
┌ Spending by category ───────────┐  ┌ November so far vs usual ───────────┐
│ Groceries  ██████████▏  £420.00 │  │ Category    So far   Usual   Change  │
│ Eating out ████▏        £120.00 │  │ All spending £810    £657   ↑ +£153  │
│ … (click one to filter)         │  │ Bills        £486    £362   ↑ +£124  │
└─────────────────────────────────┘  └──────────────────────────────────────┘
┌ Category by month ─────────────────────────────────────────── [Groceries ▾] ┐
│  monthly spending in one category, with a line at your usual month           │
└──────────────────────────────────────────────────────────────────────────────┘
Transactions in Groceries 12   (× Show all categories)
```

- **Money in and out** shows up to the last 24 months (ending at the chosen month when it's older).
  Clicking a month, or Return on it, picks that month; clicking it again goes back to all months.
- **Spending by category** is the chosen period's spending, largest first (eight, then **Show
  all**). Clicking a category shows only its transactions and charts it below. With a month
  chosen, a tick on each bar marks the usual month for that category.
- **vs usual** sets the chosen month (or the latest) against the **median** of up to six whole
  months before it: all spending first, then the categories that moved most. For the month you're
  in, only the same days of earlier months count ("so far" against "by this point in a usual
  month").
- **Category by month** charts one category with a line at its usual (median) whole month.

The numbers come from `spendingTrends` and `compareWithUsual` in `packages/money-core/src/trends.ts`,
which are built on `summarise`, so they always agree with the totals: money moved between your own
accounts is left out of All accounts, Transfers are never spending, and a refund counts as money in
rather than less spending. The first month is left out of any usual when your statements start
after the 1st, and the month you're in never counts towards it; both are drawn paler.

The charts are hand-drawn SVG with no chart library, coloured with the app's tokens, so they follow
light and dark mode. Each chart is one tab stop: arrow keys move between months, and every month
has a spoken label and a tooltip on hover or focus. The comparison is a plain table.
