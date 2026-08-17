import { describe, expect, test } from 'bun:test'

import { writeTodosParams } from '../write-todos'

describe('writeTodosParams', () => {
  test('defaults a missing `completed` field to false instead of failing validation', () => {
    const result = writeTodosParams.inputSchema.safeParse({
      todos: [{ task: 'Do the thing' }],
    })

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.todos).toEqual([
        { task: 'Do the thing', completed: false },
      ])
    }
  })

  test('still accepts an explicit `completed` value', () => {
    const result = writeTodosParams.inputSchema.safeParse({
      todos: [{ task: 'Done already', completed: true }],
    })

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.todos).toEqual([
        { task: 'Done already', completed: true },
      ])
    }
  })
})
