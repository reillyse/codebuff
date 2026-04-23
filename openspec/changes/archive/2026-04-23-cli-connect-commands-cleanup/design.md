## Context

Prior to this change, the CLI had two separate filter sets controlling which slash commands ship in each build:

- `FREEBUFF_REMOVED_COMMAND_IDS` (and `FREEBUFF_REMOVED_COMMANDS`) — commands hidden from the Freebuff build.
- `FREEBUFF_ONLY_COMMAND_IDS` (and `FREEBUFF_ONLY_COMMANDS`) — commands hidden from the regular Codebuff build.

The ChatGPT OAuth entry point was registered with id `connect` (aliases `['connect:chatgpt', 'chatgpt']`) and placed in the freebuff-only set. Meanwhile, the Claude OAuth entry point was registered with id `connect:claude` (alias `['claude']`) and was available to both builds. This left the user-facing surface asymmetric:

| Build | Claude connect command available | ChatGPT connect command available |
|---|---|---|
| Codebuff | `/connect:claude`, `/claude` | (none) |
| Freebuff | (hidden by `FREEBUFF_REMOVED_COMMAND_IDS`) | `/connect`, `/connect:chatgpt`, `/chatgpt` |

The underlying OAuth-direct routing (`sdk/src/impl/model-provider.ts`) already supported both providers in both builds — gate was purely in the CLI command-registry layer. Feature flags `CHATGPT_OAUTH_ENABLED` and `CLAUDE_OAUTH_ENABLED` are both `true` globally.

Stakeholders: end-users of the `codebuff` CLI (want parity with Freebuff), end-users of the `freebuff` CLI (shouldn't regress), and CLI maintainers who would otherwise need to keep two alias lists in sync.

## Goals / Non-Goals

### Goals
- Expose the ChatGPT OAuth entry point in the regular Codebuff build.
- Enforce a single canonical form for both connect commands (`/connect:chatgpt` and `/connect:claude`) so the two commands are symmetric and muscle memory transfers between builds.
- Keep the change surgical: only edit the command-registration layer and its tests.

### Non-Goals
- Do NOT gate `/connect:chatgpt` on `IS_FREEBUFF` inside the regular Codebuff build's OAuth-direct routing. Billing-bypass behavior is identical to `/connect:claude` and is accepted as intentional parity.
- Do NOT ungate `/plan` from the freebuff-only set (kept for a separate change).
- Do NOT change `CHATGPT_OAUTH_ENABLED` / `CLAUDE_OAUTH_ENABLED` feature-flag defaults.
- Do NOT rename the internal `InputMode` string `'connect:chatgpt'` (internal state, decoupled from command name).

## Decisions

### Decision 1: Remove `'connect'` from the freebuff-only filter sets

Dropping `'connect'` from `FREEBUFF_ONLY_COMMAND_IDS` (`slash-commands.ts`) and `FREEBUFF_ONLY_COMMANDS` (`command-registry.ts`) is the minimal way to expose the command in Codebuff. Since `CHATGPT_OAUTH_ENABLED` is already `true`, no other gating logic changes.

**Alternative considered:** introduce a new `CODEBUFF_EXPOSE_CHATGPT_OAUTH` feature flag. Rejected — `CHATGPT_OAUTH_ENABLED` already exists for exactly this purpose and adding another flag would multiply gates without justification.

### Decision 2: Rename command id from `connect` → `connect:chatgpt` and drop ALL aliases

Previously the command registered as id `'connect'` with aliases `['connect:chatgpt', 'chatgpt']`. To make `/connect:chatgpt` symmetric with `/connect:claude`, we promote the fully-qualified form to the primary id and delete the aliases. The same convention is applied to `/connect:claude` by dropping its `['claude']` alias.

**Rationale:** having three names (`/connect`, `/connect:chatgpt`, `/chatgpt`) plus the corresponding Claude three (`/connect:claude`, `/claude`) was six invocation surfaces for two real commands. Collapsing to two enforces one correct way to invoke each, matches the convention of other colon-qualified commands (`/auth:status`, `/auth:clear`, `/mode:lite`, `/mode:max`, `/ads:enable`, `/ads:disable`, `/theme:toggle`), and removes the cognitive "which one is the real command" question.

**Alternative considered:** keep aliases for ergonomics. Rejected — the colon-qualified form is only 8 extra keystrokes, the slash menu auto-completes it, and keeping aliases forever means any future third-provider connect command would have to decide whether to also add unqualified / short aliases, perpetuating the inconsistency.

### Decision 3: Update referencing user-facing strings in the same commit

Two error messages in the `/plan` and `/review` freebuff-only guards and one line in `HelpBanner` referenced the deprecated `/connect` form. These are kept in sync so that a fresh Freebuff install that hits the "not connected yet" state is told to type `/connect:chatgpt`, not `/connect`.

**Alternative considered:** leave the strings alone, accept the temporary dissonance. Rejected — the strings are the primary onboarding surface for first-time users; inconsistency there would waste credits and create support load.

### Decision 4: Use three dedicated negative tests for the removed invocation forms

The test file `cli/src/commands/__tests__/router-input.test.ts` pins:

1. `SLASH_COMMANDS` contains exactly one ChatGPT connect entry (`connect:chatgpt`) and does NOT contain `connect` or `chatgpt`.
2. `findCommand('connect:chatgpt')` resolves to the `connect:chatgpt` command.
3. `findCommand('connect')` returns `undefined`.
4. `findCommand('chatgpt')` returns `undefined`.

**Rationale:** the existing `SLASH_COMMANDS → COMMAND_REGISTRY` consistency test covers positive resolution; we need explicit negative pins so a future contributor adding `aliases: ['chatgpt']` back to the command definition immediately fails a test rather than silently re-introducing the old API.

## Risks / Trade-offs

- **[Risk] Muscle-memory regression for long-time Freebuff users typing `/connect` or `/chatgpt`** → Mitigation: the input falls through to the agent as a regular prompt (not an error), so the worst case is a nonsense assistant turn. Changelog / release notes call out the breaking change. Help banner tips line now shows the canonical form.

- **[Risk] Billing-bypass for Codebuff paying users once they run `/connect:chatgpt`** → Mitigation: this is identical to the pre-existing `/connect:claude` behavior and is accepted as intentional parity. If revenue impact materializes, `sdk/src/impl/model-provider.ts` can be amended in a follow-up to require `IS_FREEBUFF` for OAuth-direct routing; that's a separate capability and not in scope here.

- **[Risk] Renaming the primary id from `connect` → `connect:chatgpt` could break any user-side automation that piped text into the CLI containing `/connect`** → Mitigation: unlikely (the CLI is interactive/TTY), and the fallback-to-agent behavior means automation would produce a benign assistant reply rather than hanging.

- **[Trade-off] Surface area shrinkage vs. discoverability**: `/connect` was shorter and auto-discoverable via the slash menu. Cost: 8 more keystrokes on first connect (once per device). Benefit: perpetual symmetry with the rest of the colon-qualified command surface.

## Migration Plan

1. Ship in a single commit (no staged rollout needed — it's a CLI-local UX change).
2. Release notes call out: "`/connect`, `/chatgpt`, and `/claude` aliases removed — use `/connect:chatgpt` or `/connect:claude`."
3. No data migration, no server coordination, no rollback window needed (rollback = revert commit).

## Open Questions

- Should the help banner's Tips section be build-gated to show the correct connect command? Currently the Tips line is freebuff-only. If we later ungate `/plan` for Codebuff users (see non-goals), the banner text may need to surface for both builds. Out of scope here.
- Should Codebuff users connecting a ChatGPT subscription get a one-time notice that their requests will bypass Codebuff credits? Not addressed here — same status quo as Claude OAuth.
