import { CURRENT_FABLE_MODEL, CURRENT_OPUS_MODEL } from '@codebuff/common/constants/model-config'
import { buildArray } from '@codebuff/common/util/array'

import { publisher } from '../constants'

import type { SecretAgentDefinition } from '../types/secret-agent-definition'

type GeneralAgentModel = 'sol' | 'terra' | 'luna' | 'opus' | 'fable'

const MODEL_IDS: Record<GeneralAgentModel, string> = {
  sol: 'openai/gpt-5.6-sol',
  terra: 'openai/gpt-5.6-terra',
  luna: 'openai/gpt-5.6-luna',
  opus: CURRENT_OPUS_MODEL,
  fable: CURRENT_FABLE_MODEL,
}

const DISPLAY_NAMES: Record<GeneralAgentModel, string> = {
  sol: 'GPT-5 Agent',
  terra: 'Terra Agent',
  luna: 'Luna Agent',
  opus: 'Opus Agent',
  fable: 'Fable Agent',
}

const SPAWNER_PROMPTS: Record<GeneralAgentModel, string> = {
  sol: 'A general-purpose, deep-thinking agent powered by OpenAI GPT-5.6 Sol (flagship reasoning model). Use this to solve hard problems that need extended reasoning, especially as an alternative perspective to the Anthropic models. This agent has no context on the conversation history so it cannot see files you have read or previous discussion. Instead, you must provide all the relevant context via the prompt or filePaths for this agent to work well.',
  terra:
    'A balanced general-purpose agent powered by OpenAI GPT-5.6 Terra. Good for everyday problem-solving that needs solid quality without the cost of the flagship models. This agent has no context on the conversation history so it cannot see files you have read or previous discussion. Instead, you must provide all the relevant context via the prompt or filePaths for this agent to work well.',
  luna: 'A fast, low-cost agent powered by OpenAI GPT-5.6 Luna. Use Luna for quick, well-scoped tasks: short summaries, simple lookups, single-file edits, quick explanations, or anything where the answer is obvious and speed/cost matters more than depth. Prefer terra-agent when the task needs moderate reasoning or spans multiple files, and gpt-5-agent when the problem is genuinely hard or ambiguous. This agent has no context on the conversation history so it cannot see files you have read or previous discussion. Instead, you must provide all the relevant context via the prompt or filePaths for this agent to work well.',
  opus: 'A general-purpose capable agent that can be used to solve a wide range of problems. Use this to help you solve any problem. This agent has no context on the conversation history so it cannot see files you have read or previous discussion. Instead, you must provide all the relevant context via the prompt or filePaths for this agent to work well.',
  fable:
    'EXPENSIVE (~2x the cost of Opus): a premium deep-reasoning agent powered by Claude Fable, exceptionally strong at hard debugging and planning. Only spawn this agent for difficult problems where cheaper approaches (thinker, opus-agent, gpt-5-agent) have failed or are clearly insufficient. This agent has no context on the conversation history so it cannot see files you have read or previous discussion. Instead, you must provide all the relevant context via the prompt or filePaths for this agent to work well.',
}

// Reasoning effort for OpenAI models that support extended reasoning.
// Sol is the flagship reasoning tier. Terra and Luna are chat-optimized
// tiers where a reasoning effort parameter may not be applicable/supported.
const OPENAI_REASONING_EFFORT: Partial<
  Record<GeneralAgentModel, 'high' | 'medium' | 'low'>
> = {
  sol: 'high',
}

export const createGeneralAgent = (options: {
  model: GeneralAgentModel
}): Omit<SecretAgentDefinition, 'id'> => {
  const { model } = options
  // OpenAI models are routed via ChatGPT OAuth; Anthropic models (opus/fable)
  // are routed via Bedrock.
  const isOpenAI =
    model === 'sol' || model === 'terra' || model === 'luna'
  const reasoningEffort = OPENAI_REASONING_EFFORT[model]

  return {
    publisher,
    model: MODEL_IDS[model],
    ...(!isOpenAI && {
      providerOptions: {
        only: ['amazon-bedrock'],
      },
    }),
    ...(reasoningEffort && {
      reasoningOptions: {
        effort: reasoningEffort,
      },
    }),
    displayName: DISPLAY_NAMES[model],
    spawnerPrompt: SPAWNER_PROMPTS[model],
    inputSchema: {
      prompt: {
        type: 'string',
        description: 'The problem you are trying to solve',
      },
      params: {
        type: 'object',
        properties: {
          filePaths: {
            type: 'array',
            items: {
              type: 'string',
              description: 'The path to a file',
            },
            description:
              'A list of relevant file paths to read before thinking. Try to provide ALL the files that could be relevant to your request.',
          },
        },
      },
    },
    outputMode: 'last_message',
    spawnableAgents: buildArray(
      'researcher-web',
      'researcher-docs',
      !isOpenAI && 'file-picker',
      'code-searcher',
      'directory-lister',
      'glob-matcher',
      'commander',
      'context-pruner',
      model !== 'terra' && 'terra-agent',
      model !== 'luna' && 'luna-agent',
    ),
    toolNames: [
      'spawn_agents',
      'read_files',
      'read_subtree',
      'str_replace',
      'write_file',
    ],

    instructionsPrompt: buildArray(
      `Use the spawn_agents tool to spawn agents to help you complete the user request.`,
      !isOpenAI && `If you need to find more information in the codebase, file-picker is really good at finding relevant files. You should spawn multiple agents in parallel when possible to speed up the process. (e.g. spawn 3 file-pickers + 1 code-searcher + 1 researcher-web in one spawn_agents call or 3 commanders in one spawn_agents call).`,
    ).join('\n'),

    handleSteps: function* ({ params }) {
      const filePaths = params?.filePaths as string[] | undefined

      if (filePaths && filePaths.length > 0) {
        yield {
          toolName: 'read_files',
          input: { paths: filePaths },
        }
      }

      while (true) {
        // Run context-pruner before each step
        yield {
          toolName: 'spawn_agent_inline',
          input: {
            agent_type: 'context-pruner',
            params: params ?? {},
          },
          includeToolCall: false,
        } as any

        const { stepsComplete } = yield 'STEP'
        if (stepsComplete) break
      }
    },
  }
}
