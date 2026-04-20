import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test'

import { createAskUserHandler } from '../ask-user'

describe('createAskUserHandler', () => {
  let stderrSpy: ReturnType<typeof spyOn>

  beforeEach(() => {
    stderrSpy = spyOn(process.stderr, 'write').mockReturnValue(true)
  })

  afterEach(() => {
    stderrSpy.mockRestore()
  })

  function makeHandler(responses: string[]) {
    let callIndex = 0
    const readLineFn = async (_prompt: string): Promise<string> => {
      return responses[callIndex++] ?? ''
    }
    return createAskUserHandler(readLineFn)
  }

  const singleSelectInput = {
    questions: [
      {
        question: 'Which database?',
        options: [
          { label: 'PostgreSQL', description: 'Relational DB' },
          { label: 'MongoDB', description: 'Document DB' },
          { label: 'Redis', description: 'Key-value store' },
        ],
        multiSelect: false,
      },
    ],
  }

  const multiSelectInput = {
    questions: [
      {
        question: 'Which features?',
        options: [
          { label: 'Caching' },
          { label: 'Logging' },
          { label: 'Monitoring' },
        ],
        multiSelect: true,
      },
    ],
  }

  test('single-select: numeric input selects the correct option', async () => {
    const handler = makeHandler(['2'])
    const result = await handler(singleSelectInput)

    expect(result).toEqual([
      {
        type: 'json',
        value: {
          answers: [{ questionIndex: 0, selectedOption: 'MongoDB' }],
        },
      },
    ])
  })

  test('single-select: first option', async () => {
    const handler = makeHandler(['1'])
    const result = await handler(singleSelectInput)

    expect(result).toEqual([
      {
        type: 'json',
        value: {
          answers: [{ questionIndex: 0, selectedOption: 'PostgreSQL' }],
        },
      },
    ])
  })

  test('single-select: out of range number becomes otherText', async () => {
    const handler = makeHandler(['99'])
    const result = await handler(singleSelectInput)

    expect(result).toEqual([
      {
        type: 'json',
        value: {
          answers: [{ questionIndex: 0, otherText: '99' }],
        },
      },
    ])
  })

  test('single-select: non-numeric input becomes otherText', async () => {
    const handler = makeHandler(['Use SQLite instead'])
    const result = await handler(singleSelectInput)

    expect(result).toEqual([
      {
        type: 'json',
        value: {
          answers: [{ questionIndex: 0, otherText: 'Use SQLite instead' }],
        },
      },
    ])
  })

  test('empty input returns skipped', async () => {
    const handler = makeHandler([''])
    const result = await handler(singleSelectInput)

    expect(result).toEqual([{ type: 'json', value: { skipped: true } }])
  })

  test('whitespace-only input returns skipped', async () => {
    const handler = makeHandler(['   '])
    const result = await handler(singleSelectInput)

    expect(result).toEqual([{ type: 'json', value: { skipped: true } }])
  })

  test('multi-select: comma-separated numbers', async () => {
    const handler = makeHandler(['1,3'])
    const result = await handler(multiSelectInput)

    expect(result).toEqual([
      {
        type: 'json',
        value: {
          answers: [{ questionIndex: 0, selectedOptions: ['Caching', 'Monitoring'] }],
        },
      },
    ])
  })

  test('multi-select: single number still works', async () => {
    const handler = makeHandler(['2'])
    const result = await handler(multiSelectInput)

    expect(result).toEqual([
      {
        type: 'json',
        value: {
          answers: [{ questionIndex: 0, selectedOptions: ['Logging'] }],
        },
      },
    ])
  })

  test('multi-select: non-numeric input becomes otherText', async () => {
    const handler = makeHandler(['all of them'])
    const result = await handler(multiSelectInput)

    expect(result).toEqual([
      {
        type: 'json',
        value: {
          answers: [{ questionIndex: 0, otherText: 'all of them' }],
        },
      },
    ])
  })

  test('empty questions array returns skipped', async () => {
    const handler = makeHandler([])
    const result = await handler({ questions: [] })

    expect(result).toEqual([{ type: 'json', value: { skipped: true } }])
  })

  test('displays question and options on stderr', async () => {
    const handler = makeHandler(['1'])
    await handler(singleSelectInput)

    const output = stderrSpy.mock.calls.map((c) => String(c[0])).join('')
    expect(output).toContain('? Which database?')
    expect(output).toContain('1) PostgreSQL - Relational DB')
    expect(output).toContain('2) MongoDB - Document DB')
    expect(output).toContain('3) Redis - Key-value store')
  })

  test('multiple questions are asked sequentially', async () => {
    const handler = makeHandler(['1', '2'])
    const input = {
      questions: [
        {
          question: 'First?',
          options: [{ label: 'A' }, { label: 'B' }],
          multiSelect: false,
        },
        {
          question: 'Second?',
          options: [{ label: 'X' }, { label: 'Y' }],
          multiSelect: false,
        },
      ],
    }
    const result = await handler(input)

    expect(result).toEqual([
      {
        type: 'json',
        value: {
          answers: [
            { questionIndex: 0, selectedOption: 'A' },
            { questionIndex: 1, selectedOption: 'Y' },
          ],
        },
      },
    ])
  })

  test('multi-select: trailing comma is ignored', async () => {
    const handler = makeHandler(['1,3,'])
    const result = await handler(multiSelectInput)

    expect(result).toEqual([
      {
        type: 'json',
        value: {
          answers: [{ questionIndex: 0, selectedOptions: ['Caching', 'Monitoring'] }],
        },
      },
    ])
  })

  test('multi-select: embedded empty commas are ignored', async () => {
    const handler = makeHandler(['1,,3'])
    const result = await handler(multiSelectInput)

    expect(result).toEqual([
      {
        type: 'json',
        value: {
          answers: [{ questionIndex: 0, selectedOptions: ['Caching', 'Monitoring'] }],
        },
      },
    ])
  })

  test('multi-select: duplicate selections are deduplicated', async () => {
    const handler = makeHandler(['1,1,2'])
    const result = await handler(multiSelectInput)

    expect(result).toEqual([
      {
        type: 'json',
        value: {
          answers: [{ questionIndex: 0, selectedOptions: ['Caching', 'Logging'] }],
        },
      },
    ])
  })

  test('partial skip preserves already-collected answers', async () => {
    const handler = makeHandler(['1', ''])
    const input = {
      questions: [
        {
          question: 'First?',
          options: [{ label: 'A' }, { label: 'B' }],
          multiSelect: false,
        },
        {
          question: 'Second?',
          options: [{ label: 'X' }, { label: 'Y' }],
          multiSelect: false,
        },
      ],
    }
    const result = await handler(input)

    expect(result).toEqual([
      {
        type: 'json',
        value: {
          skipped: true,
          answers: [{ questionIndex: 0, selectedOption: 'A' }],
        },
      },
    ])
  })

  test('multi-select: empty input returns skipped', async () => {
    const handler = makeHandler([''])
    const result = await handler(multiSelectInput)

    expect(result).toEqual([{ type: 'json', value: { skipped: true } }])
  })
})
