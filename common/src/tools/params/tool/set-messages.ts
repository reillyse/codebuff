import z from 'zod/v4'

import { messageSchema } from '../../../types/messages/codebuff-message'
import {
  $getNativeToolCallExampleString,
  textToolResultSchema,
} from '../utils'

import type { $ToolParams } from '../../constants'

const toolName = 'set_messages'
const endsAgentStep = true
const inputSchema = z
  .object({
    messages: z.array(messageSchema),
  })
  .describe(`Set the conversation history to the provided messages.`)
const description = `
Example:
${$getNativeToolCallExampleString({
  toolName,
  inputSchema,
  input: {
    messages: [
      {
        role: 'user',
        content: 'Hello, how are you?',
      },
      {
        role: 'assistant',
        content: 'I am fine, thank you.',
      },
    ],
  },
  endsAgentStep,
})}
`.trim()

export const setMessagesParams = {
  toolName,
  endsAgentStep,
  description,
  inputSchema,
  outputSchema: textToolResultSchema(),
} satisfies $ToolParams
