import { createGeneralAgent } from './general-agent'

const definition = {
  ...createGeneralAgent({ model: 'luna' }),
  id: 'luna-agent',
}

export default definition
