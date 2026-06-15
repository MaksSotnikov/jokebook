import { describe, expect, it } from 'vitest'
import { buildLinkGraph, noteName, type IndexedNote } from './links.js'

const notes: IndexedNote[] = [
  { id: 'a', path: 'A.md', content: 'links to [[B]] and [[Folder/C]]' },
  { id: 'b', path: 'B.md', content: 'back to [[A]] and [[Missing Note]]' },
  { id: 'c', path: 'Folder/C.md', content: 'no links here' },
]

describe('noteName', () => {
  it('takes the basename without extension', () => {
    expect(noteName('Folder/My Note.md')).toBe('My Note')
    expect(noteName('Top.md')).toBe('Top')
  })
})

describe('buildLinkGraph', () => {
  const g = buildLinkGraph(notes)

  it('resolves links by name', () => {
    expect([...g.outgoing.get('a')!]).toEqual(expect.arrayContaining(['b', 'c']))
  })

  it('computes backlinks', () => {
    expect([...g.backlinks.get('a')!]).toEqual(['b'])
    expect([...g.backlinks.get('b')!]).toEqual(['a'])
  })

  it('reports unresolved targets', () => {
    expect(g.unresolved.get('b')).toEqual(['Missing Note'])
  })

  it('matches case-insensitively', () => {
    const g2 = buildLinkGraph([
      { id: 'x', path: 'X.md', content: '[[hello]]' },
      { id: 'y', path: 'Hello.md', content: '' },
    ])
    expect([...g2.outgoing.get('x')!]).toEqual(['y'])
  })

  it('ignores self-links', () => {
    const g3 = buildLinkGraph([{ id: 's', path: 'Self.md', content: '[[Self]]' }])
    expect(g3.outgoing.get('s')!.size).toBe(0)
  })
})
