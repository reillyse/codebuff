import { describe, test, expect } from 'bun:test'

import { createMarkdownStream } from '../markdown'

const R = '\x1b[0m'
const B = '\x1b[1m'
const D = '\x1b[2m'
const I = '\x1b[3m'
const CYAN = '\x1b[36m'
const GREEN = '\x1b[32m'
const MAGENTA = '\x1b[35m'
const GRAY = '\x1b[90m'

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '')

describe('markdown', () => {
  describe('headings', () => {
    test('h1 renders magenta+bold', () => {
      const md = createMarkdownStream()
      expect(md.write('# Hello\n')).toBe(`${MAGENTA}${B}Hello${R}\n`)
    })

    test('h2 renders green+bold', () => {
      const md = createMarkdownStream()
      expect(md.write('## World\n')).toBe(`${GREEN}${B}World${R}\n`)
    })

    test('h3 renders cyan+bold', () => {
      const md = createMarkdownStream()
      expect(md.write('### Sub\n')).toBe(`${CYAN}${B}Sub${R}\n`)
    })

    test('h4-h6 also render cyan+bold', () => {
      const md = createMarkdownStream()
      expect(md.write('#### Deep\n')).toBe(`${CYAN}${B}Deep${R}\n`)
    })

    test('heading with inline formatting', () => {
      const md = createMarkdownStream()
      const result = md.write('# **Bold** heading\n')
      expect(strip(result)).toBe('Bold heading\n')
      expect(result).toContain(B)
      expect(result).toContain(MAGENTA)
    })
  })

  describe('code blocks', () => {
    test('code block with language label', () => {
      const md = createMarkdownStream()
      const result = md.write('```typescript\nconst x = 1\n```\n')
      expect(result).toBe(`${GRAY}${D}// typescript${R}\n${D}const x = 1${R}\n`)
    })

    test('code block without language', () => {
      const md = createMarkdownStream()
      const result = md.write('```\ncode here\n```\n')
      expect(result).toBe(`${D}code here${R}\n`)
    })

    test('no inline formatting inside fences', () => {
      const md = createMarkdownStream()
      const result = md.write('```\n**bold** and `code`\n```\n')
      expect(result).toBe(`${D}**bold** and \`code\`${R}\n`)
    })

    test('indented code fences', () => {
      const md = createMarkdownStream()
      const result = md.write('  ```js\n  const y = 2\n  ```\n')
      expect(result).toBe(`${GRAY}${D}// js${R}\n${D}  const y = 2${R}\n`)
    })
  })

  describe('inline formatting', () => {
    test('bold with **', () => {
      const md = createMarkdownStream()
      expect(md.write('**bold** text\n')).toBe(`${B}bold${R} text\n`)
    })

    test('italic with *', () => {
      const md = createMarkdownStream()
      expect(md.write('*italic* text\n')).toBe(`${I}italic${R} text\n`)
    })

    test('italic with _', () => {
      const md = createMarkdownStream()
      expect(md.write('_italic_ text\n')).toBe(`${I}italic${R} text\n`)
    })

    test('underscore italic not triggered inside identifiers', () => {
      const md = createMarkdownStream()
      expect(md.write('some_var_name\n')).toBe('some_var_name\n')
    })

    test('inline code with backticks', () => {
      const md = createMarkdownStream()
      expect(md.write('use `foo` here\n')).toBe(`use ${GREEN}${B}foo${R} here\n`)
    })

    test('strikethrough with ~~', () => {
      const md = createMarkdownStream()
      expect(md.write('~~old~~ new\n')).toBe(`${D}old${R} new\n`)
    })

    test('markdown links', () => {
      const md = createMarkdownStream()
      expect(md.write('[click here](https://example.com)\n')).toBe(`${CYAN}click here${R}\n`)
    })

    test('image syntax consumed without stray !', () => {
      const md = createMarkdownStream()
      expect(md.write('![alt text](image.png)\n')).toBe(`${CYAN}alt text${R}\n`)
    })

    test('mixed inline formatting', () => {
      const md = createMarkdownStream()
      const result = md.write('**bold** and *italic* and `code`\n')
      expect(strip(result)).toBe('bold and italic and code\n')
      expect(result).toContain(B)
      expect(result).toContain(I)
      expect(result).toContain(GREEN)
    })
  })

  describe('block elements', () => {
    test('unordered list with -', () => {
      const md = createMarkdownStream()
      expect(md.write('- item one\n')).toBe(`${D}•${R} item one\n`)
    })

    test('unordered list with *', () => {
      const md = createMarkdownStream()
      expect(md.write('* item two\n')).toBe(`${D}•${R} item two\n`)
    })

    test('indented list item', () => {
      const md = createMarkdownStream()
      const result = md.write('  - nested\n')
      expect(strip(result)).toBe('  • nested\n')
    })

    test('ordered list', () => {
      const md = createMarkdownStream()
      expect(md.write('1. first\n')).toBe(`${D}1.${R} first\n`)
    })

    test('blockquote', () => {
      const md = createMarkdownStream()
      expect(md.write('> quoted text\n')).toBe(`${D}│${R} quoted text\n`)
    })

    test('blockquote with inline formatting', () => {
      const md = createMarkdownStream()
      const result = md.write('> **bold** quote\n')
      expect(strip(result)).toBe('│ bold quote\n')
      expect(result).toContain(B)
    })

    test('horizontal rule with ---', () => {
      const md = createMarkdownStream()
      const result = md.write('---\n')
      expect(result).toContain('─')
      expect(result).toContain(D)
    })

    test('horizontal rule with ***', () => {
      const md = createMarkdownStream()
      const result = md.write('***\n')
      expect(result).toContain('─')
    })
  })

  describe('streaming', () => {
    test('buffers incomplete lines', () => {
      const md = createMarkdownStream()
      expect(md.write('hel')).toBe('')
      expect(md.write('lo\n')).toBe('hello\n')
    })

    test('flush returns remaining buffer', () => {
      const md = createMarkdownStream()
      expect(md.write('partial')).toBe('')
      expect(md.flush()).toBe('partial')
    })

    test('flush returns empty string when buffer is empty', () => {
      const md = createMarkdownStream()
      expect(md.flush()).toBe('')
    })

    test('multi-line chunk', () => {
      const md = createMarkdownStream()
      const result = md.write('line one\nline two\n')
      expect(result).toBe('line one\nline two\n')
    })

    test('code fence state persists across chunks', () => {
      const md = createMarkdownStream()
      expect(md.write('```\n')).toBe('')
      expect(md.write('code\n')).toBe(`${D}code${R}\n`)
      expect(md.write('```\n')).toBe('')
      expect(md.write('normal\n')).toBe('normal\n')
    })

    test('flush inside code fence', () => {
      const md = createMarkdownStream()
      md.write('```\n')
      md.write('inside fence')
      expect(md.flush()).toBe(`${D}inside fence${R}`)
    })

    test('heading split across chunks', () => {
      const md = createMarkdownStream()
      expect(md.write('# Hel')).toBe('')
      const result = md.write('lo\n')
      expect(result).toBe(`${MAGENTA}${B}Hello${R}\n`)
    })
  })
})
