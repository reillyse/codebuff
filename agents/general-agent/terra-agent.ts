import { createGeneralAgent } from './general-agent'

const definition = {
  ...createGeneralAgent({ model: 'terra' }),
  id: 'terra-agent',
}

export default definition
