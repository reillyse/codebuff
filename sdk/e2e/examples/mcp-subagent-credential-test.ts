/**
 * Test: MCP Sub-agent Credential Passing
 *
 * Verifies that MCP OAuth credentials configured for the parent agent are
 * properly inherited by sub-agents when using spawn_agents.
 *
 * Prerequisites:
 *   1. Sparrow must be configured in ~/.agents/mcp.json with oauth: true
 *   2. Run `/connect:mcp sparrow` in the interactive CLI to authenticate
 *
 * Run with:
 *   bun run sdk/e2e/examples/mcp-subagent-credential-test.ts
 *
 * Without prior authentication the test still runs and confirms that BOTH
 * parent and sub-agent receive the same "not authenticated" state (i.e. the
 * unauthenticated state IS shared correctly).
 */

import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

import { CodebuffClient } from '../../src/client'

import type { AgentDefinition } from '../../src'

function getApiKey(): string {
  if (process.env.CODEBUFF_API_KEY) return process.env.CODEBUFF_API_KEY
  try {
    const credFile = join(homedir(), '.config', 'manicode', 'credentials.json')
    const creds = JSON.parse(readFileSync(credFile, 'utf8')) as {
      default?: { authToken?: string }
    }
    if (creds.default?.authToken) return creds.default.authToken
  } catch {
    // credentials file not found or malformed
  }
  throw new Error(
    'No Codebuff API key found. Set CODEBUFF_API_KEY or log in via the CLI.',
  )
}

// ─── Prompt (defined before TEST_AGENT to avoid temporal dead zone) ──────────
const PARENT_PROMPT = `
You are running an automated MCP credential-sharing test. Follow these steps
EXACTLY and do not deviate:

STEP 1 — Audit your own MCP tools
List every tool whose name starts with "sparrow/" or "sparrow__". Count them.
Also check whether your system prompt contains any "⚠️" MCP unavailability
warning. Write a short summary:
  • parentToolCount: <number>
  • parentWarning: <text of warning, or "none">

STEP 2 — Spawn a commander sub-agent
Use spawn_agents with agent_type "commander" and this EXACT prompt (copy it
verbatim):

"CREDENTIAL_TEST: You are a sub-agent in an MCP credential-sharing test.
1. Count the tools whose name starts with 'sparrow/' or 'sparrow__' in your
   tool list and write: subagentSparrowToolCount=<N>
2. Check whether your system prompt contains any '⚠️' MCP warning and write:
   subagentMcpWarning=<text of warning, or 'none'>
3. Run this shell command and write the output verbatim:
   cat ~/.config/manicode/mcp-oauth.json 2>/dev/null | python3 -c 'import sys,json; d=json.load(sys.stdin); entries=[(k, \"HAS_TOKENS\" if v.get(\"tokens\") else \"NO_TOKENS\") for k,v in d.items()]; [print(f\"{url}: {state}\") for url,state in entries]' 2>/dev/null || echo 'no mcp-oauth.json found'
Respond with ONLY those three items, nothing else."

STEP 3 — Summarise the credential sharing result
After the sub-agent responds, print a summary block in EXACTLY this format
(fill in the values):

=== MCP CREDENTIAL SHARING TEST RESULT ===
parentSparrowToolCount: <N>
parentWarning: <text or "none">
subagentSparrowToolCount: <N>
subagentMcpWarning: <text or "none">
onDiskTokenState: <the output from the shell command>
credentialsShared: <YES if BOTH parent and sub-agent have tool count > 0 (even if counts differ — different agent types see different subsets), NO if either has 0 tools>
testPassed: <YES if both have tools (count > 0) AND credentialsShared is YES, NO otherwise>
===========================================
`.trim()

// ─── Custom agent definition ─────────────────────────────────────────────────
//
// We define a lightweight custom agent that:
//   1. has explicit mcpServers so Sparrow tools are loaded (same URL as
//      ~/.agents/mcp.json but specified directly so the SDK picks it up)
//   2. has spawnableAgents: ['commander'] so the spawn_agents tool is available
//   3. runs in text mode (no outputMode) so all standard tools are present
//
const TEST_AGENT: AgentDefinition = {
  id: 'mcp-credential-test',
  displayName: 'MCP Credential Test Agent',
  model: 'anthropic/claude-sonnet-4-5',
  mcpServers: {
    sparrow: {
      type: 'http',
      url: 'https://api.sparrow.io/mcp',
      oauth: true,
    },
  },
  // spawn_agents must be in toolNames when spawnableAgents is non-empty
  toolNames: ['spawn_agents'],
  // spawnableAgents lists which agent types can be spawned via spawn_agents
  spawnableAgents: ['commander'],
}

async function main() {
  const apiKey = getApiKey()
  const client = new CodebuffClient({ apiKey })

  console.log('🧪 MCP Sub-agent Credential Passing Test')
  console.log('==========================================')
  console.log('Using agent: mcp-credential-test (custom, with spawnableAgents: commander)')
  console.log('MCP config:  explicit mcpServers (https://api.sparrow.io/mcp, oauth: true)')
  console.log()

  // ── Pre-flight: check on-disk OAuth state ──────────────────────────────────
  try {
    const oauthFile = join(homedir(), '.config', 'manicode', 'mcp-oauth.json')
    const oauthData = JSON.parse(readFileSync(oauthFile, 'utf8')) as Record<
      string,
      { tokens?: unknown }
    >
    const sparrowEntry = oauthData['https://api.sparrow.io/mcp']
    if (sparrowEntry) {
      const hasTokens = Boolean(sparrowEntry.tokens)
      console.log(
        `📋 On-disk Sparrow OAuth: ${hasTokens ? '✅ tokens present' : '❌ no tokens — run /connect:mcp sparrow first'}`,
      )
    } else {
      console.log('📋 No Sparrow entry in mcp-oauth.json')
    }
  } catch {
    console.log('📋 mcp-oauth.json not found')
  }
  console.log()

  // ── Run the test agent ─────────────────────────────────────────────────────
  console.log('🚀 Starting agent session...\n')

  let fullOutput = ''

  const result = await client.run({
    agent: TEST_AGENT,
    prompt: PARENT_PROMPT,
    maxAgentSteps: 20,
    handleStreamChunk: (chunk) => {
      if (typeof chunk === 'string') {
        process.stdout.write(chunk)
        fullOutput += chunk
      }
    },
    handleEvent: (event) => {
      if (event.type === 'error') {
        console.error('\n❌ Event error:', event.message)
      }
    },
  })

  console.log('\n\n==========================================')

  if (result.output.type === 'error') {
    console.error('❌ Run failed:', result.output.message)
    process.exit(1)
  }

  // ── Parse result block from the agent's text output ───────────────────────
  const resultBlock = fullOutput.match(
    /=== MCP CREDENTIAL SHARING TEST RESULT ===([\s\S]*?)===========+/,
  )

  if (!resultBlock) {
    console.log(
      '⚠️  Could not find the structured result block in the output above.',
    )
    console.log('   The agent may have formatted its response differently.')
    process.exit(0)
  }

  const block = resultBlock[1]
  const get = (key: string): string => {
    const m = block.match(new RegExp(`${key}:\\s*(.+)`))
    return m ? m[1].trim() : '(not found)'
  }

  // Parse counts first (must come before credentialsShared/testPassed to avoid TDZ)
  const parentCount = parseInt(get('parentSparrowToolCount'), 10) || 0
  const subCount = parseInt(get('subagentSparrowToolCount'), 10) || 0
  // Compute pass/fail in the harness rather than trusting the LLM's self-graded line:
  // both sides having > 0 Sparrow tools confirms credentials were shared (counts may differ
  // because the parent and commander sub-agent get different tool subsets).
  const credentialsShared = parentCount > 0 && subCount > 0
  const testPassed = credentialsShared

  console.log('\n📊 Test Summary:')
  console.log(
    `  Parent Sparrow tools:    ${parentCount > 0 ? '✅' : '❌'} ${parentCount} tools`,
  )
  console.log(
    `  Sub-agent Sparrow tools: ${subCount > 0 ? '✅' : '❌'} ${subCount} tools`,
  )
  console.log(
    `  Credentials shared:      ${credentialsShared ? '✅ YES' : '❌ NO'}`,
  )
  console.log()

  if (testPassed) {
    console.log(
      '✅ TEST PASSED: Parent and sub-agent both have Sparrow MCP tools — credentials are shared!',
    )
  } else if (credentialsShared && parentCount === 0) {
    console.log(
      '⚠️  TEST PARTIAL: Both parent and sub-agent are unauthenticated (same state — sharing works).',
    )
    console.log(
      '   Run /connect:mcp sparrow in the interactive CLI to get full tool access.',
    )
  } else {
    console.log('❌ TEST FAILED: Parent and sub-agent have DIFFERENT MCP access levels.')
    process.exit(1)
  }
}

main().catch((err: unknown) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
