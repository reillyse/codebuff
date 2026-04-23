## 1. Expose `/connect:chatgpt` in the regular Codebuff build

- [x] 1.1 Remove `'connect'` from `FREEBUFF_ONLY_COMMAND_IDS` in `cli/src/data/slash-commands.ts`
- [x] 1.2 Remove `'connect'` from `FREEBUFF_ONLY_COMMANDS` in `cli/src/commands/command-registry.ts`

## 2. Canonicalize the ChatGPT connect command to its fully-qualified form

- [x] 2.1 Rename the slash-menu entry id/label from `'connect'` to `'connect:chatgpt'` in `cli/src/data/slash-commands.ts`
- [x] 2.2 Update the slash-menu `description` to `'Connect your ChatGPT account via OAuth'` for symmetry with `connect:claude`
- [x] 2.3 Remove the `aliases: ['connect:chatgpt', 'chatgpt']` array from the `connect:chatgpt` slash-menu entry
- [x] 2.4 Rename the command registry `name` from `'connect'` to `'connect:chatgpt'` in `cli/src/commands/command-registry.ts`
- [x] 2.5 Remove the `aliases: ['connect:chatgpt', 'chatgpt']` array from the `connect:chatgpt` `defineCommand` call

## 3. Drop the `/claude` alias from `/connect:claude` for symmetry

- [x] 3.1 Remove `aliases: ['claude']` from the `connect:claude` slash-menu entry in `cli/src/data/slash-commands.ts`
- [x] 3.2 Remove `aliases: ['claude']` from the `connect:claude` `defineCommand` call in `cli/src/commands/command-registry.ts`

## 4. Update user-facing onboarding strings to reference `/connect:chatgpt`

- [x] 4.1 Update the `/plan` freebuff-only guard message in `cli/src/commands/command-registry.ts` from `'Use /connect to get started.'` to `'Use /connect:chatgpt to get started.'`
- [x] 4.2 Update the `/review` freebuff-only guard message in `cli/src/commands/command-registry.ts` from `'Use /connect to get started.'` to `'Use /connect:chatgpt to get started.'`
- [x] 4.3 Update the help-banner Tips line in `cli/src/components/help-banner.tsx` from `'Connect via /connect to unlock /plan & /review'` to `'Connect via /connect:chatgpt to unlock /plan & /review'`

## 5. Update and add tests

- [x] 5.1 Flip the old `'connect command is not available in codebuff (freebuff-only)'` test in `cli/src/commands/__tests__/router-input.test.ts` to pin that `'connect:chatgpt'` is the only registered ChatGPT OAuth command
- [x] 5.2 Add a positive pin: `findCommand('connect:chatgpt')` resolves to a command whose `name === 'connect:chatgpt'`
- [x] 5.3 Add a negative pin: `findCommand('connect')` returns `undefined`
- [x] 5.4 Add a negative pin: `findCommand('chatgpt')` returns `undefined`

## 6. Validate

- [x] 6.1 Run `bun run typecheck` in `cli/` — passes clean
- [x] 6.2 Run `bun test src/commands/__tests__/router-input.test.ts` in `cli/` — all 91 tests pass
- [x] 6.3 Run `bun test src/commands/__tests__/router-connect-chatgpt.test.ts` in `cli/` — input-mode flow unchanged, still passes
- [x] 6.4 Run `code-reviewer` agent — no blocking issues raised
