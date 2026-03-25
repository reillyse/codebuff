import { describe, test, expect } from 'bun:test'

import { createMarkdownStream } from '../markdown'

describe('markdown', () => {
  describe('headings', () => {
    test('h1 renders plain text', () => {
      const md = createMarkdownStream()
      expect(md.write('# Hello\n')).toBe('Hello\n')
    })

    test('h2 renders plain text', () => {
      const md = createMarkdownStream()
      expect(md.write('## World\n')).toBe('World\n')
    })

    test('h3 renders plain text', () => {
      const md = createMarkdownStream()
      expect(md.write('### Sub\n')).toBe('Sub\n')
    })

    test('h4-h6 also render plain text', () => {
      const md = createMarkdownStream()
      expect(md.write('#### Deep\n')).toBe('Deep\n')
    })

    test('heading with inline formatting', () => {
      const md = createMarkdownStream()
      const result = md.write('# **Bold** heading\n')
      expect(result).toBe('Bold heading\n')
    })
  })

  describe('code blocks', () => {
    test('code block with language label', () => {
      const md = createMarkdownStream()
      const result = md.write('```typescript\nconst x = 1\n```\n')
      expect(result).toBe('[typescript]\nconst x = 1\n')
    })

    test('code block without language', () => {
      const md = createMarkdownStream()
      const result = md.write('```\ncode here\n```\n')
      expect(result).toBe('code here\n')
    })

    test('no inline formatting inside fences', () => {
      const md = createMarkdownStream()
      const result = md.write('```\n**bold** and `code`\n```\n')
      expect(result).toBe('**bold** and `code`\n')
    })

    test('indented code fences', () => {
      const md = createMarkdownStream()
      const result = md.write('  ```js\n  const y = 2\n  ```\n')
      expect(result).toBe('[js]\n  const y = 2\n')
    })
  })

  describe('inline formatting', () => {
    test('bold with **', () => {
      const md = createMarkdownStream()
      expect(md.write('**bold** text\n')).toBe('bold text\n')
    })

    test('italic with *', () => {
      const md = createMarkdownStream()
      expect(md.write('*italic* text\n')).toBe('italic text\n')
    })

    test('italic with _', () => {
      const md = createMarkdownStream()
      expect(md.write('_italic_ text\n')).toBe('italic text\n')
    })

    test('underscore italic not triggered inside identifiers', () => {
      const md = createMarkdownStream()
      expect(md.write('some_var_name\n')).toBe('some_var_name\n')
    })

    test('inline code with backticks', () => {
      const md = createMarkdownStream()
      expect(md.write('use `foo` here\n')).toBe('use foo here\n')
    })

    test('strikethrough with ~~', () => {
      const md = createMarkdownStream()
      expect(md.write('~~old~~ new\n')).toBe('old new\n')
    })

    test('markdown links', () => {
      const md = createMarkdownStream()
      expect(md.write('[click here](https://example.com)\n')).toBe('click here\n')
    })

    test('image syntax consumed without stray !', () => {
      const md = createMarkdownStream()
      expect(md.write('![alt text](image.png)\n')).toBe('alt text\n')
    })

    test('mixed inline formatting', () => {
      const md = createMarkdownStream()
      const result = md.write('**bold** and *italic* and `code`\n')
      expect(result).toBe('bold and italic and code\n')
    })
  })

  describe('block elements', () => {
    test('unordered list with -', () => {
      const md = createMarkdownStream()
      expect(md.write('- item one\n')).toBe('- item one\n')
    })

    test('unordered list with *', () => {
      const md = createMarkdownStream()
      expect(md.write('* item two\n')).toBe('- item two\n')
    })

    test('indented list item', () => {
      const md = createMarkdownStream()
      const result = md.write('  - nested\n')
      expect(result).toBe('  - nested\n')
    })

    test('ordered list', () => {
      const md = createMarkdownStream()
      expect(md.write('1. first\n')).toBe('1. first\n')
    })

    test('blockquote', () => {
      const md = createMarkdownStream()
      expect(md.write('> quoted text\n')).toBe('| quoted text\n')
    })

    test('blockquote with inline formatting', () => {
      const md = createMarkdownStream()
      const result = md.write('> **bold** quote\n')
      expect(result).toBe('| bold quote\n')
    })

    test('horizontal rule with ---', () => {
      const md = createMarkdownStream()
      const result = md.write('---\n')
      expect(result).toContain('-')
      expect(result).not.toContain('─')
    })

    test('horizontal rule with ***', () => {
      const md = createMarkdownStream()
      const result = md.write('***\n')
      expect(result).toContain('-')
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
      expect(md.write('code\n')).toBe('code\n')
      expect(md.write('```\n')).toBe('')
      expect(md.write('normal\n')).toBe('normal\n')
    })

    test('flush inside code fence', () => {
      const md = createMarkdownStream()
      md.write('```\n')
      md.write('inside fence')
      expect(md.flush()).toBe('inside fence')
    })

    test('heading split across chunks', () => {
      const md = createMarkdownStream()
      expect(md.write('# Hel')).toBe('')
      const result = md.write('lo\n')
      expect(result).toBe('Hello\n')
    })
  })
})
