---
name: honeycomb-usage-report
description: Daily + aggregate Codebuff LLM usage breakdown from Honeycomb (past week)
---

# Honeycomb Usage Report

Generate a usage report from Honeycomb showing how LLM traffic is distributed
across the three routes (`claude_oauth`, `chatgpt_oauth`, `codebuff_backend`)
and across models, **broken down per day for the past 7 days plus a 7-day
aggregate**. This is the standard "where did my tokens go this week" report.

## How to run it

Spawn the `honeycomb` agent with these parameters and prompt. **Do not invent
attribute names** — the schema below is authoritative for the
`sparrow-codebuff` dataset and is defined in
`common/src/sparrow/telemetry/attributes.ts`.

```
agent: honeycomb
params:
  environment: codebuff
  dataset: sparrow-codebuff
prompt: <see "Prompt template" below>
```

## Prompt template

```
Produce a 7-day usage report from `gen_ai.chat` spans in the `sparrow-codebuff`
dataset. I need TWO sets of breakdowns:

=== PART 1 — DAILY ===
For each of the last 7 days (granularity: 1 day), GROUP BY:
  - codebuff.route
  - gen_ai.request.model

CALCULATE:
  - COUNT (number of LLM calls)
  - SUM(gen_ai.usage.input_tokens)
  - SUM(gen_ai.usage.output_tokens)
  - SUM(gen_ai.usage.cache_read_tokens)
  - SUM(gen_ai.usage.cache_creation_tokens)
  - SUM(codebuff.cost.usd)               -- only populated for codebuff_backend
  - SUM(codebuff.cost.credits)            -- only populated for codebuff_backend

Time range: last 7 days, granularity 1 day.

=== PART 2 — 7-DAY AGGREGATE ===
Same GROUP BY (codebuff.route, gen_ai.request.model) and same CALCULATE list,
but with NO time granularity — one row per (route, model) combination summed
across the full 7-day window.

=== PART 3 — IDENTITY SLICE (only if data is present) ===
Also do a 7-day aggregate GROUP BY:
  - codebuff.route
  - host.name
  - user.email
  - codebuff.oauth_account_id

CALCULATE the same token sums. ORDER BY SUM(gen_ai.usage.output_tokens) DESC
and LIMIT 20 — this slice can fan out as adoption grows.

This shows usage per machine / per git-config user / per OAuth subscription.
Note: `host.name`, `user.email`, and `codebuff.oauth_account_id` are only
present on `gen_ai.chat` spans for releases shipped after the telemetry
identity-propagation change. Older spans only carry these on the `prompt`
root span (requires a trace join). If the columns are empty for the window
you're querying, call it out and report whatever is present.

=== OUTPUT FORMAT ===
Return three markdown tables (one per part). For Part 1, structure as:
  Date | Route | Model | Calls | Input | Output | CacheRead | CacheCreate | Cost$
For Part 2, drop the Date column.
For Part 3, columns: Route | host.name | user.email | oauth_account_id | Calls | Input | Output | CacheRead

Use thousands separators on token counts. Round cost to 4 decimals.

After the tables, include a 3-5 bullet summary highlighting:
  - Which route dominates output tokens this week
  - Which model dominates within each route
  - Any day-over-day spikes (>2x previous day)
  - Whether chatgpt_oauth has any meaningful traffic
  - Total backend cost across the week
```

## Attribute reference

These come from `common/src/sparrow/telemetry/attributes.ts`. If you need to
extend the report, add attributes from there — don't invent names.

| Purpose | Attribute |
|---|---|
| Route classification | `codebuff.route` (values: `claude_oauth`, `chatgpt_oauth`, `codebuff_backend`, `direct_<provider>`) |
| Model id | `gen_ai.request.model` |
| Input tokens | `gen_ai.usage.input_tokens` |
| Output tokens | `gen_ai.usage.output_tokens` |
| Cache read tokens | `gen_ai.usage.cache_read_tokens` |
| Cache creation tokens | `gen_ai.usage.cache_creation_tokens` |
| Cost (USD) | `codebuff.cost.usd` (codebuff_backend only) |
| Cost (credits) | `codebuff.cost.credits` (codebuff_backend only) |
| Per-account ID (OAuth) | `codebuff.oauth_account_id` |
| Machine | `host.name` |
| Git user | `user.email` |
| Session | `session.id` |

## Known caveats

- **`chatgpt_oauth`** has historically shown near-zero traffic — verify whether
  this is a real adoption signal or a routing bug before raising alarms.
- **`codebuff.cost.usd`** is only populated for the `codebuff_backend` route.
  OAuth routes show $0 because we don't pay per-call (subscription pricing).
  Do NOT compute hypothetical OpenRouter-equivalent cost in this report —
  that's a separate analysis that requires pulling current OpenRouter pricing.
- **Identity columns** (`host.name`, `user.email`, `codebuff.oauth_account_id`)
  are only present on `gen_ai.chat` spans from releases that include the
  identity-propagation change. Older spans won't have them; the prompt-root
  span carries them for older data and requires a trace join.
- The `(untagged)` route bucket should be near zero — flag it if it's >1% of
  calls.
- **`gen_ai.usage.cache_creation_tokens`** may be absent from older spans —
  the column was added in the same telemetry batch that introduced the
  identity attributes. If empty for an older window, treat it as 0 and note
  the caveat in the report rather than calling it a bug.

