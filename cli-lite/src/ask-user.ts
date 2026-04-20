/**
 * ask_user tool handler for cli-lite.
 * Displays questions on stderr with numbered options and reads answers from stdin.
 */

import { writeErr } from './tty'

import type { ClientToolCall, CodebuffToolOutput } from '@codebuff/sdk'

type ReadLineFn = (prompt: string) => Promise<string>

type AskUserInput = ClientToolCall<'ask_user'>['input']
type AskUserQuestion = AskUserInput['questions'][number]

interface AnswerFields {
  selectedOption?: string
  selectedOptions?: string[]
  otherText?: string
}

export function createAskUserHandler(readLineFn: ReadLineFn): (input: AskUserInput) => Promise<CodebuffToolOutput<'ask_user'>> {
  return async (input) => {
    const { questions } = input

    if (!questions || questions.length === 0) {
      return [{ type: 'json' as const, value: { skipped: true } }]
    }

    const answers: Array<AnswerFields & { questionIndex: number }> = []

    for (let qi = 0; qi < questions.length; qi++) {
      const q = questions[qi]
      writeErr('\n')
      writeErr(`? ${q.question}\n`)

      for (let i = 0; i < q.options.length; i++) {
        const opt = q.options[i]
        const desc = opt.description ? ` - ${opt.description}` : ''
        writeErr(`  ${i + 1}) ${opt.label}${desc}\n`)
      }

      const hint = q.multiSelect
        ? 'Enter numbers separated by commas, type a custom answer, or press Enter to skip: '
        : 'Enter a number, type a custom answer, or press Enter to skip: '

      const response = await readLineFn(hint)
      const trimmed = response.trim()

      if (!trimmed) {
        const value = answers.length > 0 ? { skipped: true, answers } : { skipped: true }
        return [{ type: 'json' as const, value }]
      }

      const answer = parseAnswer(trimmed, q)
      answers.push({ questionIndex: qi, ...answer })
    }

    return [{ type: 'json' as const, value: { answers } }]
  }
}

function parseAnswer(
  input: string,
  question: AskUserQuestion,
): AnswerFields {
  if (question.multiSelect) {
    const parts = input.split(',').map((s) => s.trim()).filter(Boolean)
    const allNumeric = parts.length > 0 && parts.every((p) => /^\d+$/.test(p))

    if (allNumeric) {
      const indices = parts.map((p) => parseInt(p, 10) - 1)
      const valid = Array.from(new Set(indices.filter((i) => i >= 0 && i < question.options.length)))
      if (valid.length > 0) {
        return { selectedOptions: valid.map((i) => question.options[i].label) }
      }
    }

    return { otherText: input }
  }

  if (/^\d+$/.test(input)) {
    const idx = parseInt(input, 10) - 1
    if (idx >= 0 && idx < question.options.length) {
      return { selectedOption: question.options[idx].label }
    }
  }

  return { otherText: input }
}
