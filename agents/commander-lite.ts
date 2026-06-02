import { CURRENT_HAIKU_MODEL } from '@codebuff/common/constants/model-config'

import commander from './commander'

import type { AgentDefinition } from './types/agent-definition'

const definition: AgentDefinition = {
  ...commander,
  id: 'commander-lite',
  displayName: 'Commander Lite',
  model: CURRENT_HAIKU_MODEL,
}

export default definition
