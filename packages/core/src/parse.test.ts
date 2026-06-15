import { describe, expect, it } from 'vitest'
import { parseNote, parseTags, parseWikiLinks } from './parse.js'

describe('parseWikiLinks', () => {
  it('extracts a simple link', () => {
    const links = parseWikiLinks('see [[My Note]] here')
    expect(links).toHaveLength(1)
    expect(links[0]).toMatchObject({ target: 'My Note', alias: undefined, start: 4 })
  })

  it('parses an aliased link', () => {
    const [link] = parseWikiLinks('go to [[target|display text]]')
    expect(link.target).toBe('target')
    expect(link.alias).toBe('display text')
  })

  it('finds multiple links and trims whitespace', () => {
    const links = parseWikiLinks('[[ A ]] and [[B]]')
    expect(links.map((l) => l.target)).toEqual(['A', 'B'])
  })

  it('ignores empty links', () => {
    expect(parseWikiLinks('[[]] and [[ | x ]]')).toHaveLength(0)
  })
})

describe('parseTags', () => {
  it('extracts distinct unicode tags without the hash', () => {
    expect(parseTags('#idea #проект and #idea again')).toEqual(['idea', 'проект'])
  })

  it('supports nested tags', () => {
    expect(parseTags('#area/work')).toEqual(['area/work'])
  })

  it('does not treat a number-only token as a tag', () => {
    expect(parseTags('issue #123 done')).toEqual([])
  })

  it('does not match # inside a word', () => {
    expect(parseTags('color#fff')).toEqual([])
  })
})

describe('parseNote', () => {
  it('splits frontmatter, body, links and tags', () => {
    const raw = ['---', 'title: Hello', '---', 'Body with [[Other]] and #tag'].join('\n')
    const note = parseNote(raw)
    expect(note.frontmatter).toEqual({ title: 'Hello' })
    expect(note.body.trim()).toBe('Body with [[Other]] and #tag')
    expect(note.wikiLinks.map((l) => l.target)).toEqual(['Other'])
    expect(note.tags).toEqual(['tag'])
  })

  it('handles notes without frontmatter', () => {
    const note = parseNote('just text')
    expect(note.frontmatter).toEqual({})
    expect(note.body).toBe('just text')
  })
})
