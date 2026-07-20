import { endsAgentStepParam } from '@codebuff/common/tools/constants'
import { toolParams } from '@codebuff/common/tools/list'
import { AVAILABLE_SKILLS_PLACEHOLDER } from '@codebuff/common/tools/params/tool/skill'
import { getToolCallString } from '@codebuff/common/tools/utils'
import { buildArray } from '@codebuff/common/util/array'
import { formatAvailableSkillsXml } from '@codebuff/common/util/skills'
import { pluralize } from '@codebuff/common/util/string'
import { jsonSchema } from 'ai'
import { cloneDeep } from 'lodash'
import z from 'zod/v4'
import { convertJsonSchemaToZod } from 'zod-from-json-schema'

import type { ToolName } from '@codebuff/common/tools/constants'
import type { SkillsMap } from '@codebuff/common/types/skill'
import type {
  CustomToolDefinitions,
  customToolDefinitionsSchema,
} from '@codebuff/common/util/file'
import type { ToolSet } from 'ai'

/**
 * Ensures the inputSchema is a Zod schema. If it's a JSON Schema object
 * (from SDK custom tools that were serialized), converts it to Zod.
 */
export function ensureZodSchema(
  schema: z.ZodType | Record<string, unknown>,
): z.ZodType {
  // Check if it's already a Zod schema by looking for the safeParse method
  if (
    schema &&
    typeof (schema as { safeParse?: unknown }).safeParse === 'function'
  ) {
    return schema as z.ZodType
  }
  // JSON Schema object - convert to Zod
  return convertJsonSchemaToZod(schema as Record<string, unknown>)
}

function ensureJsonSchemaCompatible(schema: z.ZodType): z.ZodType {
  try {
    z.toJSONSchema(schema, { io: 'input' })
    return schema
  } catch {
    const fallback = z.object({}).passthrough()
    return schema.description ? fallback.describe(schema.description) : fallback
  }
}

function toJsonSchemaSafe(schema: z.ZodType): Record<string, unknown> {
  try {
    return z.toJSONSchema(schema, { io: 'input' }) as Record<string, unknown>
  } catch {
    return { type: 'object', properties: {} }
  }
}

function hasMeaningfulJsonSchema(jsonSchema: Record<string, unknown>): boolean {
  const properties = jsonSchema.properties
  if (properties && typeof properties === 'object' && Object.keys(properties).length > 0) {
    return true
  }

  for (const key of ['allOf', 'anyOf', 'oneOf']) {
    const value = jsonSchema[key]
    if (Array.isArray(value) && value.length > 0) {
      return true
    }
  }

  const required = jsonSchema.required
  if (Array.isArray(required) && required.length > 0) {
    return true
  }

  return false
}

/**
 * Builds the JSON-Schema view of a tool's params for the system prompt, adding
 * the `endsAgentStep` flag when required. When `rawInputSchema` (the original
 * JSON Schema from an MCP tool) is provided we use it directly rather than
 * round-tripping through Zod — the round-trip can silently drop property
 * descriptions/`$defs`/`format` keywords, leaving the model with an empty
 * schema and no idea what the real parameter names are (it then guesses wrong
 * names from its training knowledge).
 */
function buildParamsJsonSchema(params: {
  schema: z.ZodType
  endsAgentStep: boolean
  rawInputSchema?: Record<string, unknown>
}): Record<string, unknown> {
  const { schema, endsAgentStep, rawInputSchema } = params

  if (rawInputSchema && typeof rawInputSchema === 'object') {
    // Use the original JSON Schema directly. Strip $schema meta key (adds
    // noise); strip description (shown separately in the tool header).
    const {
      $schema: _$schema,
      description: _description,
      ...rest
    } = rawInputSchema
    const resultSchema: Record<string, unknown> = { ...rest }

    if (endsAgentStep) {
      const properties = {
        ...((resultSchema.properties as Record<string, unknown> | undefined) ?? {}),
      }
      properties[endsAgentStepParam] = {
        type: 'boolean',
        const: endsAgentStep,
        description: 'Easp flag must be set to true',
      }
      resultSchema.properties = properties
      const required = Array.isArray(resultSchema.required)
        ? [...(resultSchema.required as unknown[])]
        : []
      if (!required.includes(endsAgentStepParam)) {
        required.push(endsAgentStepParam)
      }
      resultSchema.required = required
    }
    return resultSchema
  }

  const safeSchema = ensureJsonSchemaCompatible(schema)
  const schemaWithEndsAgentStepParam = endsAgentStep
    ? safeSchema.and(
      z.object({
        [endsAgentStepParam]: z
          .literal(endsAgentStep)
          .describe('Easp flag must be set to true'),
      }),
    )
    : safeSchema
  const resultSchema = toJsonSchemaSafe(schemaWithEndsAgentStepParam)
  delete resultSchema.description
  delete resultSchema['$schema']
  return resultSchema
}

function paramsSection(params: {
  schema: z.ZodType
  endsAgentStep: boolean
  rawInputSchema?: Record<string, unknown>
}) {
  const resultSchema = buildParamsJsonSchema(params)
  const jsonSchema = resultSchema
  const paramsDescription = hasMeaningfulJsonSchema(resultSchema)
    ? JSON.stringify(resultSchema, null, 2)
    : 'None'

  let paramsSection = ''
  if (paramsDescription.length === 1 && paramsDescription[0] === 'None') {
    paramsSection = 'Params: None'
  } else if (paramsDescription.length > 0) {
    paramsSection = `Params: ${paramsDescription}`
  }
  return paramsSection
}

// Helper function to build the full tool description markdown
export function buildToolDescription(params: {
  toolName: string
  schema: z.ZodType
  description?: string
  endsAgentStep: boolean
  exampleInputs?: any[]
  rawInputSchema?: Record<string, unknown>
}): string {
  const {
    toolName,
    schema,
    description = '',
    endsAgentStep,
    exampleInputs = [],
    rawInputSchema,
  } = params
  const descriptionWithExamples = buildArray(
    description,
    exampleInputs.length > 0
      ? `${pluralize(exampleInputs.length, 'Example')}:`
      : '',
    ...exampleInputs.map((example) =>
      getToolCallString(toolName, example, endsAgentStep),
    ),
  ).join('\n\n')
  return buildArray([
    `### ${toolName}`,
    schema.description || '',
    paramsSection({ schema, endsAgentStep, rawInputSchema }),
    descriptionWithExamples,
  ]).join('\n\n')
}

export const toolDescriptions = Object.fromEntries(
  Object.entries(toolParams).map(([name, config]) => [
    name,
    buildToolDescription({
      toolName: name,
      schema: config.inputSchema,
      description: config.description,
      endsAgentStep: config.endsAgentStep,
    }),
  ]),
) as Record<keyof typeof toolParams, string>

function buildShortToolDescription(params: {
  toolName: string
  schema: z.ZodType
  endsAgentStep: boolean
  rawInputSchema?: Record<string, unknown>
}): string {
  const { toolName, schema, endsAgentStep, rawInputSchema } = params
  return `${toolName}:\n${paramsSection({ schema, endsAgentStep, rawInputSchema })}`
}

export const getToolsInstructions = (
  tools: readonly string[],
  additionalToolDefinitions: NonNullable<
    z.input<typeof customToolDefinitionsSchema>
  >,
  options?: { availableSkillsXml?: string },
) => {
  if (
    tools.length === 0 &&
    Object.keys(additionalToolDefinitions).length === 0
  ) {
    return ''
  }

  return `
# Tools

You (Buffy) have access to the following tools. Call them when needed.

## [CRITICAL] Formatting Requirements

Tool calls use a specific XML and JSON-like format. Adhere *precisely* to this nested element structure:

${getToolCallString(
    'tool_name',
    {
      parameter1: 'value1',
      parameter2: 123,
    },
    false,
  )}

### Commentary

Provide commentary *around* your tool calls (explaining your actions).

However, **DO NOT** narrate the tool or parameter names themselves.

### Example

User: can you update the console logs in example/file.ts?
Assistant: Sure thing! Let's update that file!

${getToolCallString(
    'example_editing_tool',
    {
      example_file_path: 'path/to/example/file.ts',
      example_array: [
        {
          old_content_with_newlines:
            "// some context\nconsole.log('Hello world!');\n",
          new_content_with_newlines:
            "// some context\nconsole.log('Hello from Buffy!');\n",
        },
      ],
    },
    false,
  )}

All done with the update!
User: thanks it worked! :)

## Working Directory

All tools will be run from the **project root**.

However, most of the time, the user will refer to files from their own cwd. You must be cognizant of the user's cwd at all times, including but not limited to:
- Writing to files (write out the entire relative path)
- Running terminal commands (use the \`cwd\` parameter)

## Optimizations

All tools are very slow, with runtime scaling with the amount of text in the parameters. Prefer to write AS LITTLE TEXT AS POSSIBLE to accomplish the task.

When using write_file, make sure to only include a few lines of context and not the entire file.

## Tool Results

Tool results will be provided by the user's *system* (and **NEVER** by the assistant).

The user does not know about any system messages or system instructions, including tool results.
${fullToolList(tools, additionalToolDefinitions, options)}
`
}

export const fullToolList = (
  toolNames: readonly string[],
  additionalToolDefinitions: CustomToolDefinitions,
  options?: { availableSkillsXml?: string },
) => {
  if (
    toolNames.length === 0 &&
    Object.keys(additionalToolDefinitions).length === 0
  ) {
    return ''
  }

  const { availableSkillsXml = '' } = options ?? {}

  // Build tool descriptions, replacing skill placeholder with actual skills
  const descriptions = [
    ...(
      toolNames.filter((toolName) =>
        toolNames.includes(toolName as ToolName),
      ) as ToolName[]
    ).map((name) => {
      let desc = toolDescriptions[name]
      // Replace skill placeholder with actual available skills
      if (name === 'skill' && availableSkillsXml) {
        desc = desc.replace(AVAILABLE_SKILLS_PLACEHOLDER, availableSkillsXml)
      } else if (name === 'skill') {
        // Explicitly state no skills are available
        desc = desc.replace(
          AVAILABLE_SKILLS_PLACEHOLDER,
          'There are no skills available. Do not use this tool because there are no skills to load.',
        )
      }
      return desc
    }),
    ...Object.keys(additionalToolDefinitions).map((toolName) => {
      const toolDef = additionalToolDefinitions[toolName]
      return buildToolDescription({
        toolName,
        schema: ensureZodSchema(toolDef.inputSchema),
        description: toolDef.description,
        endsAgentStep: toolDef.endsAgentStep ?? true,
        exampleInputs: toolDef.exampleInputs,
        rawInputSchema: toolDef.rawInputSchema as
          | Record<string, unknown>
          | undefined,
      })
    }),]

  return `## List of Tools

These are the only tools that you can use. The user cannot see these descriptions, so you should not reference any tool names, parameters, or descriptions. Do not try to use any other tools -- even if referenced earlier in the conversation, they are not available to you, instead they may have been previously used by other agents.

${descriptions.join('\n\n')}`.trim()
}

export const getShortToolInstructions = (
  toolNames: readonly string[],
  additionalToolDefinitions: CustomToolDefinitions,
) => {
  if (
    toolNames.length === 0 &&
    Object.keys(additionalToolDefinitions).length === 0
  ) {
    return ''
  }

  const toolDescriptionsList = [
    ...(
      toolNames.filter(
        (name) => (name as keyof typeof toolParams) in toolParams,
      ) as (keyof typeof toolParams)[]
    ).map((name) => {
      const tool = toolParams[name]
      return buildShortToolDescription({
        toolName: name,
        schema: tool.inputSchema,
        endsAgentStep: tool.endsAgentStep,
      })
    }),
    ...Object.keys(additionalToolDefinitions).map((name) => {
      const { inputSchema, endsAgentStep, rawInputSchema } =
        additionalToolDefinitions[name]
      return buildShortToolDescription({
        toolName: name,
        schema: ensureZodSchema(inputSchema),
        endsAgentStep: endsAgentStep ?? true,
        rawInputSchema: rawInputSchema as
          | Record<string, unknown>
          | undefined,
      })
    }),
  ]

  return `## Tools
Use the tools below to complete the user request, if applicable.

Tool calls use a specific XML and JSON-like format. Adhere *precisely* to this nested element structure:

${getToolCallString(
    'tool_name',
    {
      parameter1: 'value1',
      parameter2: 123,
    },
    false,
  )}

Important: You only have access to the tools below. Do not use any other tools -- they are not available to you, instead they may have been previously used by other agents.

${toolDescriptionsList.join('\n\n')}
`.trim()
}

/**
 * Maximum characters allowed for an MCP tool's top-level description.
 * Sparrow tools average ~750 chars but the model only needs the first
 * sentence or two to know which tool to call. Reduced from 200 to 100:
 * on 400+ Sparrow tools this saves another several thousand tokens, and
 * the tool NAME (e.g. sparrow_people_add_email) already conveys intent.
 */
const MAX_MCP_TOOL_DESCRIPTION_CHARS = 100

/**
 * Recursively truncate `description` strings in a JSON Schema object to at
 * most `maxChars` characters. When `maxChars` is 0, descriptions are REMOVED
 * entirely. Handles nested `properties`, `items`, `allOf`/`anyOf`/`oneOf`
 * arrays, and `$defs`. Never mutates the original.
 *
 * On MCP-heavy setups (e.g. 400+ Sparrow tools), verbose per-property
 * descriptions (deprecation notes, internal ticket refs, edge-case
 * walkthroughs) are the biggest driver of tool-schema token cost — measured
 * at ~75k tokens on a 400-tool Sparrow session. Removing them keeps argument
 * names and types intact so the model still knows what to pass: well-named
 * params (person_id, campaign_id, ...) carry the intent; the schema
 * STRUCTURE is what matters.
 */
function truncatePropertyDescriptions(
  schema: Record<string, unknown>,
  maxChars = 0,
): Record<string, unknown> {
  const truncateDesc = (s: Record<string, unknown>): Record<string, unknown> => {
    const result: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(s)) {
      if (k === 'description' && typeof v === 'string' && v.length > maxChars) {
        if (maxChars <= 0) {
          // Drop property descriptions entirely — the single biggest
          // context-floor reduction on MCP-heavy sessions.
          continue
        }
        result[k] = v.slice(0, maxChars) + '…'
      } else if (k === 'properties' && v && typeof v === 'object' && !Array.isArray(v)) {
        const truncatedProps: Record<string, unknown> = {}
        for (const [propKey, propVal] of Object.entries(v as Record<string, unknown>)) {
          truncatedProps[propKey] =
            propVal && typeof propVal === 'object' && !Array.isArray(propVal)
              ? truncateDesc(propVal as Record<string, unknown>)
              : propVal
        }
        result[k] = truncatedProps
      } else if (k === 'items' && v && typeof v === 'object' && !Array.isArray(v)) {
        result[k] = truncateDesc(v as Record<string, unknown>)
      } else if ((k === 'allOf' || k === 'anyOf' || k === 'oneOf') && Array.isArray(v)) {
        result[k] = v.map((entry) =>
          entry && typeof entry === 'object' && !Array.isArray(entry)
            ? truncateDesc(entry as Record<string, unknown>)
            : entry,
        )
      } else if (k === '$defs' && v && typeof v === 'object' && !Array.isArray(v)) {
        const truncatedDefs: Record<string, unknown> = {}
        for (const [defKey, defVal] of Object.entries(v as Record<string, unknown>)) {
          truncatedDefs[defKey] =
            defVal && typeof defVal === 'object' && !Array.isArray(defVal)
              ? truncateDesc(defVal as Record<string, unknown>)
              : defVal
        }
        result[k] = truncatedDefs
      } else {
        result[k] = v
      }
    }
    return result
  }
  return truncateDesc(schema)
}

export async function getToolSet(params: {
  toolNames: string[]
  additionalToolDefinitions: () => Promise<CustomToolDefinitions>
  agentTools: ToolSet
  skills: SkillsMap
  includeCacheControl?: boolean
}): Promise<ToolSet> {
  const { toolNames, additionalToolDefinitions, agentTools, skills, includeCacheControl } = params

  // Generate available skills XML for the skill tool description
  const availableSkillsXml = formatAvailableSkillsXml(skills)
  const toolSet: ToolSet = {}
  for (const toolName of toolNames) {
    if (toolName in toolParams) {
      const toolDef = toolParams[toolName as ToolName]

      // For the skill tool, replace the placeholder with actual available skills
      if (toolName === 'skill' && availableSkillsXml) {
        let description = toolDef.description ?? ''
        description = description.replace(
          AVAILABLE_SKILLS_PLACEHOLDER,
          availableSkillsXml,
        )
        toolSet[toolName] = {
          ...toolDef,
          description,
        }
      } else if (toolName === 'skill') {
        // Explicitly state no skills are available
        let description = toolDef.description ?? ''
        description = description.replace(
          AVAILABLE_SKILLS_PLACEHOLDER,
          'There are no skills available. Do not use this tool because there are no skills to load.',
        )
        toolSet[toolName] = {
          ...toolDef,
          description,
        }
      } else {
        toolSet[toolName] = toolDef
      }
    }
  }

  // Skip MCP tools entirely when toolNames is explicitly empty. An agent with
  // toolNames: [] wants NO tools — loading 400+ Sparrow MCP schemas
  // (~82k tokens) for it would be pure waste and pushes the non-prunable
  // floor over the safe input budget, causing an infinite pruning loop.
  const toolDefinitions = toolNames.length === 0 ? {} : await additionalToolDefinitions()
  for (const [toolName, toolDefinition] of Object.entries(toolDefinitions)) {
    const clonedDef = cloneDeep(toolDefinition)
    if (
      clonedDef.rawInputSchema &&
      typeof clonedDef.rawInputSchema === 'object'
    ) {
      // MCP tools: register the ORIGINAL JSON Schema directly via the AI SDK's
      // jsonSchema() wrapper instead of round-tripping through Zod. The
      // round-trip can silently drop property descriptions/$defs/format
      // keywords, collapsing the tool to an empty passthrough object — which
      // leaves native-tool-calling models (e.g. the top-level agent) guessing
      // wrong parameter names from prior knowledge. Strip meta keys that add
      // noise ($schema) or interfere with strict validation
      // (additionalProperties). Downstream Zod validation still runs in
      // parseRawCustomToolCall, so the non-validating jsonSchema() here is fine.
      const {
        $schema: _$schema,
        additionalProperties: _additionalProperties,
        ...rawSchema
      } = clonedDef.rawInputSchema as Record<string, unknown>
      // Hard-cap the tool description. The first-paragraph split('\n\n')[0]
      // was a no-op for Sparrow tools (no blank lines in their descriptions).
      // A 500-char cap actually reduces tokens: Sparrow descs avg ~750 chars.
      const rawDesc = clonedDef.description ?? ''
      const truncatedDescription =
        rawDesc.length > MAX_MCP_TOOL_DESCRIPTION_CHARS
          ? rawDesc.slice(0, MAX_MCP_TOOL_DESCRIPTION_CHARS).trimEnd() + '…'
          : rawDesc
      // Also strip per-property descriptions in the input schema. On
      // MCP-heavy setups (e.g. 400+ Sparrow tools), verbose per-property
      // descriptions (deprecation notes, internal ticket refs, edge-case
      // walkthroughs) dominate the tool-schema token cost (~75k tokens
      // measured on a 400-tool Sparrow session, enough to make the
      // non-prunable context floor EXCEED the safe input budget and cause
      // an infinite context-overflow loop). Removing them (maxChars = 0)
      // keeps the argument names and types intact so the model still knows
      // what to pass — well-named params carry the intent.
      const trimmedRawSchema = truncatePropertyDescriptions(
        rawSchema as Record<string, unknown>,
        0,
      )
      toolSet[toolName] = {
        ...clonedDef,
        description: truncatedDescription,
        inputSchema: jsonSchema(trimmedRawSchema as Parameters<typeof jsonSchema>[0]),
      } as (typeof toolSet)[string]
    } else {
      // Custom tool inputSchema may be JSON Schema (from SDK) or Zod (from MCP)
      // Ensure it's a Zod schema for the AI SDK
      const zodSchema = ensureZodSchema(clonedDef.inputSchema)
      const safeSchema = ensureJsonSchemaCompatible(zodSchema)
      toolSet[toolName] = {
        ...clonedDef,
        inputSchema: safeSchema,
      } as (typeof toolSet)[string]
    }
  }

  // Add agent tools (agents as direct tool calls). Defense-in-depth: only
  // inject these when the agent actually has spawn_agents in its toolNames.
  // An agent without spawn_agents can never spawn sub-agents, so a non-empty
  // agentTools map for such an agent would be pure token waste (a parent's
  // full spawnableAgents list can be 30+ agents = ~100k tokens). This mirrors
  // the build-time skip in run-agent-step.ts (agentTools is already {} there),
  // so this is a belt-and-suspenders guard. Note we gate on spawn_agents
  // presence — NOT per-agent-id toolNames membership — because agents list
  // `spawn_agents` (not individual agent IDs) in toolNames, and the
  // direct-agent-tool-call mechanism needs every built agent tool present.
  if (toolNames.includes('spawn_agents')) {
    for (const [toolName, toolDefinition] of Object.entries(agentTools)) {
      toolSet[toolName] = toolDefinition
    }
  }

  // Mark the last tool with cache_control so @ai-sdk/anthropic caches the
  // entire tools block. Anthropic's prompt caching treats everything up to
  // (and including) the cache-breakpoint tool as a single cacheable prefix,
  // saving ~60k tokens of re-tokenisation per step on MCP-heavy sessions.
  // Mutate providerOptions in-place to avoid reconstructing the full Tool
  // object (which would require re-asserting required fields like inputSchema).
  if (includeCacheControl) {
    const lastToolName = Object.keys(toolSet).at(-1)
    if (lastToolName) {
      const lastTool = toolSet[lastToolName] as unknown as Record<string, unknown>
      const existingProviderOptions = (lastTool.providerOptions as Record<string, unknown> | undefined) ?? {}
      const existingAnthropic = (existingProviderOptions.anthropic as Record<string, unknown> | undefined) ?? {}
      lastTool.providerOptions = {
        ...existingProviderOptions,
        anthropic: { ...existingAnthropic, cacheControl: { type: 'ephemeral' } },
      }
    }
  }

  return toolSet
}
