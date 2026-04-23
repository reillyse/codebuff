## Why

The CLI's ChatGPT OAuth entry point was hidden from the regular Codebuff build (freebuff-only) even though both feature flags (`CHATGPT_OAUTH_ENABLED`, `CLAUDE_OAUTH_ENABLED`) are globally enabled and the underlying OAuth-direct routing already works in both builds. Users running the regular `codebuff` CLI had no way to connect their ChatGPT subscription, and the command surface was asymmetric: `/connect:claude` exposed its short alias `/claude`, but `/connect:chatgpt` was gated behind `IS_FREEBUFF`. This change unifies the connect-command surface so that every Codebuff user can link either provider, and both are invoked by the same fully-qualified naming convention.

## What Changes

- Expose `/connect:chatgpt` in the regular Codebuff build (previously freebuff-only).
- **BREAKING**: Rename the ChatGPT OAuth command id from `connect` to `connect:chatgpt` and drop the `/chatgpt` short alias. Only `/connect:chatgpt` is now accepted.
- **BREAKING**: Drop the `/claude` short alias from `/connect:claude`. Only `/connect:claude` is now accepted.
- Update the user-facing prompts in the `/plan` and `/review` freebuff-only guards from "Use /connect to get started." → "Use /connect:chatgpt to get started.".
- Update the Tips section of the help banner from "Connect via /connect …" → "Connect via /connect:chatgpt …".

## Capabilities

### New Capabilities
- `cli-slash-commands`: Governs which slash commands are registered in the Codebuff and Freebuff CLI builds, and the naming/alias rules for OAuth-connect commands. This capability codifies the command-surface invariants that were previously encoded only in per-file filter sets (`FREEBUFF_ONLY_COMMAND_IDS`, `FREEBUFF_REMOVED_COMMAND_IDS`) and implicit alias lists.

### Modified Capabilities
<!-- No existing spec governed the slash-command surface; this change introduces the first one. -->

## Impact

- **CLI only**: `cli/src/data/slash-commands.ts`, `cli/src/commands/command-registry.ts`, `cli/src/components/help-banner.tsx`, and `cli/src/commands/__tests__/router-input.test.ts`.
- **No runtime / routing changes**: `CHATGPT_OAUTH_ENABLED` and `CLAUDE_OAUTH_ENABLED` remain `true` globally; `sdk/src/impl/model-provider.ts` OAuth-direct routing is unchanged.
- **Breaking for muscle-memory users**: anyone typing `/connect`, `/chatgpt`, or `/claude` will get no-match (input falls through to the agent as a regular message). Release notes / changelog should call this out.
- **Billing posture (already shipped in freebuff)**: once a Codebuff user runs `/connect:chatgpt`, eligible OpenAI-model requests route direct to their ChatGPT subscription and consume zero Codebuff credits — same pattern as `/connect:claude`.
