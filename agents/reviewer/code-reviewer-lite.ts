import { CURRENT_HAIKU_MODEL } from '@codebuff/common/constants/model-config'

import { publisher } from '../constants'
import type { SecretAgentDefinition } from '../types/secret-agent-definition'
import { createReviewer } from './code-reviewer'

const definition: SecretAgentDefinition = {
  id: 'code-reviewer-lite',
  publisher,
  ...createReviewer(CURRENT_HAIKU_MODEL),
}

export default definition
