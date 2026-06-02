# Hippo Accuracy Evaluation Design

> **Status: Draft** — This document describes the planned evaluation framework. The `evals/hippo/` directory and automation described in Phase 2 and 3 are not yet implemented.

## Goal

Measure whether hippo context injection improves subagent accuracy, starting with the **file-picker** agent (highest expected impact).

## What We're Measuring

### File-Picker Accuracy

The file-picker receives a prompt and returns up to 12 relevant files. We measure:

1. **Precision**: What fraction of returned files were actually needed?
2. **Recall**: What fraction of needed files were returned?
3. **F1 Score**: Harmonic mean of precision and recall
4. **Rank Quality**: Were the most important files ranked higher? (NDCG)

### Commander Accuracy

Harder to measure objectively. Proxy metrics:

1. **Prompt relevance**: Does the LLM summary reference context that was injected?
2. **Error rate**: Does hippo context reduce command failures?
3. **Retry rate**: Does hippo context reduce the need for follow-up commands?

## Evaluation Approach

### A/B Comparison

For each test case, run the file-picker **twice**:

| Variant | Description |
|---|---|
| **Baseline** | File-picker with original prompt (no hippo context) |
| **Enhanced** | File-picker with hippo-enriched prompt |

Compare the file lists returned by each variant against ground truth.

### Ground Truth Sources

1. **Historical runs**: Extract ground truth from completed coding sessions:
   - Files the user actually read (`read_files` tool calls)
   - Files the user actually modified (`write_file`, `str_replace` tool calls)
   - These represent the "actually needed" file set

2. **Curated test cases**: Hand-crafted prompts with known-correct file lists:
   ```yaml
   - prompt: "Fix the authentication redirect loop"
     ground_truth:
       - cli/src/utils/auth.ts
       - sdk/src/constants.ts
       - web/src/app/api/v1/me/route.ts
     hippo_context: "Previous session worked on auth redirect from codebuff.com to www.codebuff.com"
   ```

3. **Buffbench integration**: Extend the existing eval framework to include file-picker accuracy as a metric.

## Eval Pipeline

### Step 1: Collect Historical Data

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│  Past runs   │────▶│  Extract     │────▶│  Test cases  │
│  (hippo DB)  │     │  ground truth│     │  (YAML)      │
└──────────────┘     └──────────────┘     └──────────────┘
```

Script: `evals/hippo/extract-ground-truth.ts`

- Query hippo for recent sessions with file changes
- For each session, extract the user prompt and files touched
- Generate test case YAML with prompt + ground truth files

### Step 2: Run A/B Comparison

```
┌──────────────┐     ┌──────────────────────────────────┐
│  Test case   │────▶│  Run file-picker twice:          │
│  (prompt +   │     │  1. Baseline (no hippo context)   │
│   ground     │     │  2. Enhanced (with hippo context)  │
│   truth)     │     │                                    │
└──────────────┘     └──────────────┬───────────────────┘
                                    │
                                    ▼
                     ┌──────────────────────────────────┐
                     │  Compare both file lists against  │
                     │  ground truth → precision/recall   │
                     └──────────────────────────────────┘
```

Script: `evals/hippo/run-file-picker-eval.ts`

```typescript
interface EvalResult {
  testCase: string
  baseline: {
    files: string[]
    precision: number
    recall: number
    f1: number
  }
  enhanced: {
    files: string[]
    precision: number
    recall: number
    f1: number
  }
  improvement: {
    precisionDelta: number
    recallDelta: number
    f1Delta: number
  }
}
```

### Step 3: Aggregate and Report

```
┌──────────────────────────────────────────────────────────┐
│  File-Picker Accuracy Report                             │
│                                                          │
│  Test cases: 50                                          │
│                                                          │
│  Metric      │ Baseline │ Enhanced │ Δ        │ p-value  │
│  ────────────┼──────────┼──────────┼──────────┼────────  │
│  Precision   │ 0.72     │ 0.81     │ +0.09    │ 0.003    │
│  Recall      │ 0.65     │ 0.78     │ +0.13    │ 0.001    │
│  F1          │ 0.68     │ 0.79     │ +0.11    │ 0.002    │
│                                                          │
│  Cases where enhanced won:  38/50 (76%)                  │
│  Cases where baseline won:   8/50 (16%)                  │
│  Ties:                       4/50 (8%)                   │
└──────────────────────────────────────────────────────────┘
```

## Implementation Plan

### Phase 1: Manual Validation (Now)

1. Enable hippo hooks for file-picker in cli-lite
2. Use the tool normally for a week
3. Manually inspect hippo-enriched file-picker prompts in `debug/hippo-interactions.log`
4. Count how often the injected context led to better file selection

### Phase 2: Automated Eval Framework

1. Create `evals/hippo/` directory with:
   - `extract-ground-truth.ts` — extracts test cases from hippo history
   - `run-file-picker-eval.ts` — runs A/B comparison
   - `report.ts` — generates accuracy report
   - `test-cases/` — curated YAML test cases

2. Add to buffbench:
   - New metric: `file-picker-accuracy`
   - Compare with/without hippo context

### Phase 3: Continuous Measurement

1. Log file-picker accuracy metrics to hippo itself:
   ```
   hippo store --agent codebuff-eval \
     --input "file-picker accuracy" \
     --output "precision=0.81 recall=0.78 f1=0.79" \
     --outcome success
   ```

2. Track accuracy trends over time as hippo accumulates more context

## Key Questions to Answer

1. **Does hippo context improve file-picker accuracy?** (Primary)
2. **How much latency does the hippo search add?** (3s timeout, but actual time?)
3. **Does accuracy improve as more sessions are stored?** (Learning curve)
4. **Are there cases where hippo context hurts accuracy?** (False context)
5. **What's the optimal context length?** (Too much context may confuse the LLM)

## Success Criteria

- **Minimum**: F1 improvement ≥ 0.05 across 50+ test cases
- **Target**: F1 improvement ≥ 0.10 with p-value < 0.05
- **Stretch**: Recall improvement ≥ 0.15 (hippo helps find files the LLM would miss)

## Risks

| Risk | Mitigation |
|---|---|
| Hippo context is stale/irrelevant | Session-scoped context search, short timeout |
| Added latency hurts UX | 3s timeout, no retry for subagents |
| False context leads to wrong files | Monitor precision; disable for specific projects |
| Hippo unavailable in CI/containers | Hooks are no-ops when hippo binary is absent |
