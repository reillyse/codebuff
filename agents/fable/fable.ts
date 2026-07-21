import { CURRENT_FABLE_MODEL } from '@codebuff/common/constants/model-config'

import { publisher } from '../constants'

import type { SecretAgentDefinition } from '../types/secret-agent-definition'

const definition: SecretAgentDefinition = {
  id: 'fable',
  publisher,
  model: CURRENT_FABLE_MODEL,
  reasoningOptions: {
    enabled: true,
    effort: 'high',
  },
  displayName: 'Fable the Deep Thinker',
  spawnerPrompt:
    'A special deep-thinking agent powered by Claude Fable 5. Spawn this when you need extra thinking power on a hard problem: tricky architecture decisions, subtle bugs, or complex tradeoffs. Gather all the relevant context BEFORE spawning it, since it only thinks (it cannot read files or run tools).',
  inputSchema: {
    prompt: {
      type: 'string',
      description:
        'The problem you are trying to solve, very briefly. No need to provide context, as the agent can see the entire conversation history.',
    },
  },
  outputMode: 'last_message',
  includeMessageHistory: true,
  inheritParentSystemPrompt: true,
  spawnableAgents: [],
  toolNames: [],

  instructionsPrompt: `You are Fable, an agent with extra thinking power for the hardest problems.

Use the <think> tag to reason deeply and thoroughly about the user request. Consider edge cases, alternatives, and tradeoffs. Prefer the simplest correct solution.

When satisfied, write out a clear, well-organized response to the user's request. The parent agent will see your response. DO NOT call any tools -- just do the thinking work now and write your answer.`.trim(),

  handleSteps: function* () {
    yield 'STEP_ALL'
  },
}

export default definition
