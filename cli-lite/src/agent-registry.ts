
import {
  loadLocalAgents as sdkLoadLocalAgents,
  loadMCPConfigSync,
} from '@codebuff/sdk'

import type { AgentDefinition } from '@codebuff/sdk'

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let userAgentsCache: Record<string, AgentDefinition> = {}
// eslint-disable-next-line -- typed loosely since loadMCPConfigSync returns opaque server configs
let mcpServersCache: Record<string, unknown> = {}
let bundledAgentsCache: Record<string, AgentDefinition> = {}
let initialized = false

const debug = (...args: unknown[]): void => {
  if (process.env.CODEBUFF_DEBUG) {
    process.stderr.write(`[agent-registry] ${args.map(String).join(' ')}\n`)
  }
}

// ---------------------------------------------------------------------------
// Bundled agents (generated at build time by prebuild-agents.ts)
// ---------------------------------------------------------------------------

try {
  const mod = require('./agents/bundled-agents.generated')
  bundledAgentsCache = mod.bundledAgents ?? {}
  debug(`Loaded ${Object.keys(bundledAgentsCache).length} bundled agents`)
} catch (e) {
  // File not generated yet - running in development without prebuild
  debug('No bundled agents file found (dev mode):', e)
}

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

/**
 * Initialize the agent registry by loading user agents and skills via the SDK.
 * Call this once at CLI startup before sending any prompts.
 *
 * Agents are loaded from:
 *  - {cwd}/.agents (project)
 *  - {cwd}/../.agents (parent, e.g. monorepo root)
 *  - ~/.agents (global, user's home directory)
 */
export async function initializeAgentRegistry(): Promise<void> {
  if (initialized) return

  // Load user agents from .agents directories
  try {
    userAgentsCache = await sdkLoadLocalAgents({ verbose: false })
    debug(`Loaded ${Object.keys(userAgentsCache).length} user agents`)
  } catch (error) {
    debug('Failed to load user agents:', error)
    userAgentsCache = {}
  }

  // Load MCP config from mcp.json files in .agents directories
  try {
    const mcpConfig = loadMCPConfigSync({ verbose: false })
    mcpServersCache = mcpConfig.mcpServers ?? {}
    if (Object.keys(mcpServersCache).length > 0) {
      debug(`Loaded ${Object.keys(mcpServersCache).length} MCP servers`)
    }
  } catch (error) {
    debug('Failed to load MCP config:', error)
    mcpServersCache = {}
  }

  initialized = true
}

// ---------------------------------------------------------------------------
// Agent definitions (merged bundled + user)
// ---------------------------------------------------------------------------

/**
 * Get all agent definitions, merging bundled agents with user agents.
 * User agents can override bundled agents with the same ID.
 * User agent IDs are auto-added to base agents' spawnableAgents list.
 */
export function getAgentDefinitions(): AgentDefinition[] {
  // Start with bundled agents
  const definitions: AgentDefinition[] = Object.values(bundledAgentsCache).map(
    (def) => ({ ...def }),
  )
  const bundledIds = new Set(Object.keys(bundledAgentsCache))

  // Merge user agents
  const userAgentDefs = Object.values(userAgentsCache)
  const userAgentIds = userAgentDefs.map((def) => def.id)

  for (const agentDef of userAgentDefs) {
    if (bundledIds.has(agentDef.id)) {
      const idx = definitions.findIndex((d) => d.id === agentDef.id)
      if (idx !== -1) {
        definitions[idx] = { ...agentDef }
      }
    } else {
      definitions.push({ ...agentDef })
    }
  }

  // Auto-add user agent IDs to spawnableAgents of base agents
  if (userAgentIds.length > 0) {
    for (const def of definitions) {
      if (def.id.startsWith('base') && def.spawnableAgents) {
        const existingSpawnable = new Set(def.spawnableAgents)
        for (const userAgentId of userAgentIds) {
          if (!existingSpawnable.has(userAgentId)) {
            def.spawnableAgents = [...def.spawnableAgents, userAgentId]
          }
        }
      }
    }
  }

  // Merge MCP servers into base agents
  if (Object.keys(mcpServersCache).length > 0) {
    for (const def of definitions) {
      if (def.id.startsWith('base')) {
        if (!def.mcpServers) {
          def.mcpServers = {}
        }
        def.mcpServers = { ...def.mcpServers, ...(mcpServersCache as typeof def.mcpServers) }
      }
    }
  }

  return definitions
}

export interface AgentListEntry {
  id: string
  displayName: string
  source: 'bundled' | 'user'
  model?: string
}

/**
 * Get a structured list of all loaded agents for display.
 */
export function getAgentList(): AgentListEntry[] {
  const entries: AgentListEntry[] = []

  for (const [id, def] of Object.entries(bundledAgentsCache)) {
    // Skip if overridden by a user agent
    if (id in userAgentsCache) continue
    entries.push({
      id,
      displayName: def.displayName ?? id,
      source: 'bundled',
      model: typeof def.model === 'string' ? def.model : undefined,
    })
  }

  for (const [id, def] of Object.entries(userAgentsCache)) {
    entries.push({
      id,
      displayName: def.displayName ?? id,
      source: id in bundledAgentsCache ? 'user' : 'user',
      model: typeof def.model === 'string' ? def.model : undefined,
    })
  }

  entries.sort((a, b) => a.id.localeCompare(b.id))
  return entries
}

/**
 * Look up a single agent by ID. User agents take precedence over bundled.
 */
export function getAgentById(id: string): AgentDefinition | null {
  return userAgentsCache[id] ?? bundledAgentsCache[id] ?? null
}

/**
 * Determine the source of an agent by ID.
 */
export function getAgentSource(id: string): 'user' | 'bundled' | null {
  if (id in userAgentsCache) return 'user'
  if (id in bundledAgentsCache) return 'bundled'
  return null
}
/**
 * Get a summary of loaded agents for display.
 */
export function getAgentSummary(): string | null {
  const bundledCount = Object.keys(bundledAgentsCache).length
  const userCount = Object.keys(userAgentsCache).length
  const mcpCount = Object.keys(mcpServersCache).length

  const parts: string[] = []
  if (bundledCount > 0) parts.push(`${bundledCount} bundled`)
  if (userCount > 0) parts.push(`${userCount} user`)
  if (mcpCount > 0) parts.push(`${mcpCount} MCP servers`)

  if (parts.length === 0) return null
  return `Agents: ${parts.join(', ')}`
}
