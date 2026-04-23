# cli-slash-commands Specification

## Purpose
TBD - created by archiving change cli-connect-commands-cleanup. Update Purpose after archive.
## Requirements
### Requirement: ChatGPT OAuth connect command is available in both Codebuff and Freebuff builds

The CLI SHALL register a single ChatGPT OAuth connect command with id `connect:chatgpt` in both the regular Codebuff build and the Freebuff build, whenever the `CHATGPT_OAUTH_ENABLED` feature flag is `true`. The command MUST NOT be filtered out of `SLASH_COMMANDS` or `COMMAND_REGISTRY` by any build-specific filter set.

#### Scenario: Codebuff build exposes connect:chatgpt in the slash menu
- **WHEN** the CLI is started with `FREEBUFF_MODE` unset or not equal to `'true'` and `CHATGPT_OAUTH_ENABLED` is `true`
- **THEN** `SLASH_COMMANDS` contains exactly one entry with id `'connect:chatgpt'`
- **THEN** `findCommand('connect:chatgpt')` returns a defined command whose `name` equals `'connect:chatgpt'`

#### Scenario: Freebuff build exposes connect:chatgpt in the slash menu
- **WHEN** the CLI is started with `FREEBUFF_MODE='true'` and `CHATGPT_OAUTH_ENABLED` is `true`
- **THEN** `SLASH_COMMANDS` contains exactly one entry with id `'connect:chatgpt'`
- **THEN** `findCommand('connect:chatgpt')` returns a defined command whose `name` equals `'connect:chatgpt'`

#### Scenario: Feature flag disabled hides the command in both builds
- **WHEN** `CHATGPT_OAUTH_ENABLED` is `false`
- **THEN** `SLASH_COMMANDS` contains no entry with id `'connect:chatgpt'`
- **THEN** `findCommand('connect:chatgpt')` returns `undefined`

### Requirement: Claude OAuth connect command is available in both Codebuff and Freebuff builds

The CLI SHALL register a single Claude OAuth connect command with id `connect:claude` in both the regular Codebuff build and the Freebuff build, whenever the `CLAUDE_OAUTH_ENABLED` feature flag is `true`. The command MUST NOT be filtered out of `SLASH_COMMANDS` or `COMMAND_REGISTRY` by any build-specific filter set.

#### Scenario: Codebuff build exposes connect:claude in the slash menu
- **WHEN** the CLI is started with `FREEBUFF_MODE` unset or not equal to `'true'` and `CLAUDE_OAUTH_ENABLED` is `true`
- **THEN** `SLASH_COMMANDS` contains exactly one entry with id `'connect:claude'`
- **THEN** `findCommand('connect:claude')` returns a defined command whose `name` equals `'connect:claude'`

#### Scenario: Freebuff build exposes connect:claude in the slash menu
- **WHEN** the CLI is started with `FREEBUFF_MODE='true'` and `CLAUDE_OAUTH_ENABLED` is `true`
- **THEN** `SLASH_COMMANDS` contains exactly one entry with id `'connect:claude'`
- **THEN** `findCommand('connect:claude')` returns a defined command whose `name` equals `'connect:claude'`

### Requirement: Connect commands require the fully-qualified form

Every OAuth-connect command SHALL be invocable only by its fully-qualified colon-namespaced name (`connect:<provider>`). The command registry MUST NOT expose short aliases (e.g., `connect`, `chatgpt`, `claude`) for any connect command.

#### Scenario: /connect:chatgpt resolves but /connect and /chatgpt do not
- **WHEN** `CHATGPT_OAUTH_ENABLED` is `true`
- **THEN** `findCommand('connect:chatgpt')` returns a defined command
- **THEN** `findCommand('connect')` returns `undefined`
- **THEN** `findCommand('chatgpt')` returns `undefined`

#### Scenario: /connect:claude resolves but /claude does not
- **WHEN** `CLAUDE_OAUTH_ENABLED` is `true`
- **THEN** `findCommand('connect:claude')` returns a defined command whose `name` equals `'connect:claude'`
- **THEN** `findCommand('claude')` returns `undefined`

#### Scenario: Command definitions carry empty alias arrays
- **WHEN** the `COMMAND_REGISTRY` entry for `connect:chatgpt` or `connect:claude` is inspected
- **THEN** its `aliases` array is empty

### Requirement: User-facing onboarding prompts reference the fully-qualified connect command

Any user-visible string in the CLI that directs the user to initiate the ChatGPT OAuth flow SHALL reference the command by its fully-qualified name `/connect:chatgpt`. Previously-deprecated forms (`/connect`, `/chatgpt`) MUST NOT appear in any user-facing prompt, error message, or help banner.

#### Scenario: /plan freebuff-only guard message directs to /connect:chatgpt
- **WHEN** a user invokes `/plan` in the Freebuff build without a connected ChatGPT account
- **THEN** the resulting system message contains the substring `"Use /connect:chatgpt to get started."`

#### Scenario: /review freebuff-only guard message directs to /connect:chatgpt
- **WHEN** a user invokes `/review` in the Freebuff build without a connected ChatGPT account
- **THEN** the resulting system message contains the substring `"Use /connect:chatgpt to get started."`

#### Scenario: Help banner tips line in Freebuff references /connect:chatgpt
- **WHEN** the help banner is rendered in the Freebuff build with no ChatGPT OAuth connection
- **THEN** the Tips section contains the substring `"Connect via /connect:chatgpt to unlock /plan & /review"`

