import { describe, expect, it } from 'vitest'
import { escapeListBullets } from './markdown.js'

describe('escapeListBullets', () => {
  it('escapes a leading dash so it renders literally', () => {
    expect(escapeListBullets('- Привет!')).toBe('\\- Привет!')
  })

  it('escapes every line of a dialogue, including after a text line', () => {
    expect(escapeListBullets('Он говорит:\n- Привет!\n- Пока!')).toBe(
      'Он говорит:\n\\- Привет!\n\\- Пока!',
    )
  })

  it('escapes * and + markers, tab-separated and lone markers', () => {
    expect(escapeListBullets('* сноска\n+ плюс\n-\tтаб\n-')).toBe(
      '\\* сноска\n\\+ плюс\n\\-\tтаб\n\\-',
    )
  })

  it('keeps indentation and blockquote prefixes', () => {
    expect(escapeListBullets('  - вложенный\n> - цитата\n>- тоже')).toBe(
      '  \\- вложенный\n> \\- цитата\n>\\- тоже',
    )
  })

  it('leaves numbered lists alone', () => {
    expect(escapeListBullets('1. Раз\n2) Два')).toBe('1. Раз\n2) Два')
  })

  it('leaves thematic breaks alone', () => {
    const text = 'a\n\n---\n\n- - -\n\n* * *\n\n___'
    expect(escapeListBullets(text)).toBe(text)
  })

  it('only touches a marker followed by whitespace', () => {
    const text = '**жирный**\n*курсив*\n-слово\n--> стрелка\n+1'
    expect(escapeListBullets(text)).toBe(text)
  })

  it('leaves indented code (4+ spaces) alone', () => {
    const text = 'текст\n\n    - код'
    expect(escapeListBullets(text)).toBe(text)
  })

  it('leaves fenced code untouched and resumes after the fence closes', () => {
    expect(escapeListBullets('```js\n- код\n```\n- текст')).toBe('```js\n- код\n```\n\\- текст')
    expect(escapeListBullets('~~~\n- код\n~~~\n- текст')).toBe('~~~\n- код\n~~~\n\\- текст')
  })

  it('does not close a fence on a shorter or different fence run', () => {
    const text = '````\n```\n- код\n~~~~\n- ещё код'
    expect(escapeListBullets(text)).toBe(text)
  })

  it('treats a backtick run with backticks after it as inline code, not a fence', () => {
    expect(escapeListBullets('``` a ` b\n- текст')).toBe('``` a ` b\n\\- текст')
  })

  it('normalizes CRLF line endings', () => {
    expect(escapeListBullets('- a\r\n- b')).toBe('\\- a\n\\- b')
  })
})
