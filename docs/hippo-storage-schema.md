# Hippo Storage Schema Design

## Overview

Hippo is a local memory system that stores and retrieves context from past coding sessions. This document describes the storage schema used when Codebuff subagents (commander, file-picker, etc.) store results back to hippo.

## Current Schema

Hippo's `store` CLI command accepts these fields:

| Field | Flag | Description | Example |
|---|---|---|---|
| Agent | `--agent` | Identifies the tool/agent that produced the run | `codebuff`, `codebuff-commander` |
| Session | `--session` | Groups runs within a session | `codebuff-lite-default-2025-01-15-1430` |
| Input | `--input` | What was asked | `[DEFAULT] fix the auth bug` |
| Output | `--output` | What happened / result summary | `Modified: src/auth.ts, src/login.ts` |
| Outcome | `--outcome` | Success classification | `success`, `failure`, `discovery` |
| Files Changed | `--files-changed` | Comma-separated file paths | `src/auth.ts,src/login.ts` |

## Subagent Storage Schema

Subagent results use the same `hippo store` interface with distinct conventions:

### Agent Naming

Subagent stores use the pattern `codebuff-{agentType}`:

- `codebuff-commander` — terminal command results
- `codebuff-commander-lite` — lightweight terminal command results
- `codebuff-file-picker` — file discovery results
- `codebuff-file-picker-max` — extended file discovery results

This distinguishes subagent runs from top-level `codebuff` runs in hippo's graph, enabling queries like "what commands were run recently" vs "what tasks were completed."

### Input Format

Subagent inputs use a tagged format:

```
[subagent:{agentType}] {truncated prompt}
```

Example:
```
[subagent:commander] Check if tests pass
[subagent:file-picker] Find files related to authentication and OAuth flow
```

The prompt is truncated to 200 characters to keep hippo's storage compact.

### Output Format

Output varies by result type:

- **Success with message**: The agent's output message (truncated to 500 chars)
- **Success without message**: `Completed (Ns)` with elapsed time
- **Error**: `Error: {message}`

### Outcome Classification

- `success` — agent completed normally
- `failure` — agent returned an error

Note: Subagents don't use `discovery` since that classification is for top-level read-only runs.

### Session ID

Subagent stores reuse the parent session ID, so all runs (top-level + subagent) within a session are grouped together. This enables hippo to reconstruct the full session timeline.

## Context Retrieval Schema

When a subagent is about to run, hippo is queried via `context-search`:

```
hippo context-search "{prompt}" --session {sessionId} --quiet
```

### Timeout Strategy

| Caller | Timeout | Retry |
|---|---|---|
| Top-level prompt | 15s (with 5s retry) | Once on transient errors |
| Subagent prompt | 3s | None (latency-sensitive) |

Subagents use a shorter timeout because:
1. They run frequently (multiple per prompt)
2. Each adds latency to the overall response
3. Missing context is less critical than for top-level prompts

### Returned Context Format

Hippo returns context as a structured text block that gets injected under a header:

```
## Relevant Context from Past Sessions
{hippo context output}

{original subagent prompt}
```

The context typically includes:
- Related concepts and their reference counts
- Past session summaries with relevant details
- Related skills (procedures, patterns)

## Data Flow

```
┌─────────────┐     ┌──────────────────┐     ┌─────────────┐
│  User sends │     │  Top-level agent  │     │   Subagent  │
│   prompt    │────▶│  (base2/base2-max)│────▶│  (commander │
│             │     │                  │     │   file-pick) │
└─────────────┘     └──────────────────┘     └──────┬──────┘
                                                     │
                              ┌───────────────────────┤
                              │                       │
                              ▼                       ▼
                    ┌──────────────────┐    ┌──────────────────┐
                    │ onBeforeSubagent │    │ onAfterSubagent  │
                    │    Prompt        │    │    Complete       │
                    │                  │    │                  │
                    │ hippo context-   │    │ hippo store      │
                    │ search (3s)      │    │ (fire-and-forget)│
                    └──────────────────┘    └──────────────────┘
```

## Future Extensions

### Additional Agent Types

The `HIPPO_ENRICHED_AGENTS` list can be expanded:

| Priority | Agent | Rationale |
|---|---|---|
| 1 | commander, commander-lite | Command context from past sessions |
| 2 | file-picker, file-picker-max | Past file discovery improves accuracy |
| 3 | opus-agent, gpt-5-agent | "What we tried before" context |
| 4 | researcher-web, researcher-docs | Avoid redundant research |

### Structured Output Storage

Currently output is stored as plain text. Future versions could store structured data:

```
hippo store --agent codebuff-file-picker \
  --output-json '{"files": ["src/auth.ts", "src/login.ts"], "relevance": "high"}'
```

This would enable richer queries like "what files were found relevant to auth."

### Cross-Session Learning

Hippo's dream phase can analyze subagent patterns across sessions to build reusable knowledge:

- File-picker: "When working on auth, these files are almost always relevant"
- Commander: "This test command is used frequently in this project"
