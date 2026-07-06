import { createGeneralAgent } from './general-agent'

const definition = {
  ...createGeneralAgent({ model: 'fable' }),
  id: 'fable-agent',
}

export default definition
