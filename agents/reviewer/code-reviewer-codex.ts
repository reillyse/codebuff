import { CURRENT_GPT5_MODEL } from '@codebuff/common/constants/model-config'

import { publisher } from '../constants'
import type { SecretAgentDefinition } from '../types/secret-agent-definition'
import { createReviewer } from './code-reviewer'

const definition: SecretAgentDefinition = {
  id: 'code-reviewer-codex',
  publisher,
  ...createReviewer(CURRENT_GPT5_MODEL),
}

export default definition