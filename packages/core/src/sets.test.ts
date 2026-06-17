import { describe, expect, it } from 'vitest'
import {
  addBitToSet,
  clearBitOverride,
  getBitOverride,
  getBitOverrides,
  isSetNote,
  moveBitInSet,
  parseSet,
  removeBitFromSet,
  renderSet,
  setBitOverride,
} from './sets.js'

describe('parseSet', () => {
  it('reads ordered bit paths from a set note', () => {
    expect(parseSet(':::set\nbits/a.md\nbits/b.md\n:::\n')).toEqual(['bits/a.md', 'bits/b.md'])
  })

  it('treats an empty block as a set with no bits', () => {
    expect(parseSet(':::set\n:::\n')).toEqual([])
  })

  it('ignores leading blank lines and trims paths', () => {
    expect(parseSet('\n\n:::set\n  bits/a.md  \n:::')).toEqual(['bits/a.md'])
  })

  it('tolerates CRLF line endings', () => {
    expect(parseSet(':::set\r\nbits/a.md\r\n:::\r\n')).toEqual(['bits/a.md'])
  })

  it('returns null for a regular note', () => {
    expect(parseSet('just a note\n:::set in the middle')).toBeNull()
    expect(parseSet('# heading')).toBeNull()
    expect(parseSet('')).toBeNull()
  })
})

describe('isSetNote', () => {
  it('distinguishes sets from regular notes', () => {
    expect(isSetNote(':::set\nbits/a.md\n:::\n')).toBe(true)
    expect(isSetNote(':::set\n:::\n')).toBe(true)
    expect(isSetNote('not a set')).toBe(false)
  })
})

describe('renderSet', () => {
  it('round-trips through parseSet', () => {
    const bits = ['bits/a.md', 'bits/b.md']
    expect(parseSet(renderSet(bits))).toEqual(bits)
  })

  it('renders an empty set', () => {
    expect(renderSet([])).toBe(':::set\n:::\n')
  })
})

describe('addBitToSet', () => {
  it('appends a new bit at the end', () => {
    expect(parseSet(addBitToSet(':::set\nbits/a.md\n:::\n', 'bits/b.md'))).toEqual([
      'bits/a.md',
      'bits/b.md',
    ])
  })

  it('is a no-op when the bit is already present', () => {
    const content = ':::set\nbits/a.md\n:::\n'
    expect(addBitToSet(content, 'bits/a.md')).toBe(content)
  })

  it('starts a set body from an empty set', () => {
    expect(parseSet(addBitToSet(':::set\n:::\n', 'bits/a.md'))).toEqual(['bits/a.md'])
  })
})

describe('removeBitFromSet', () => {
  it('drops the named bit', () => {
    expect(parseSet(removeBitFromSet(':::set\nbits/a.md\nbits/b.md\n:::\n', 'bits/a.md'))).toEqual([
      'bits/b.md',
    ])
  })

  it('is a no-op when the bit is absent', () => {
    const content = ':::set\nbits/a.md\n:::\n'
    expect(removeBitFromSet(content, 'bits/x.md')).toBe(content)
  })
})

describe('moveBitInSet', () => {
  const content = ':::set\na.md\nb.md\nc.md\n:::\n'

  it('moves a bit up', () => {
    expect(parseSet(moveBitInSet(content, 1, -1))).toEqual(['b.md', 'a.md', 'c.md'])
  })

  it('moves a bit down', () => {
    expect(parseSet(moveBitInSet(content, 1, 1))).toEqual(['a.md', 'c.md', 'b.md'])
  })

  it('is a no-op at the edges', () => {
    expect(moveBitInSet(content, 0, -1)).toBe(content)
    expect(moveBitInSet(content, 2, 1)).toBe(content)
  })
})

describe('bit overrides', () => {
  const base = ':::set\na.md\nb.md\n:::\n'

  it('has no overrides by default', () => {
    expect(getBitOverrides(base).size).toBe(0)
    expect(getBitOverride(base, 'a.md')).toBeNull()
  })

  it('stores set-local text without touching the playlist', () => {
    const next = setBitOverride(base, 'a.md', 'reworked text')
    expect(parseSet(next)).toEqual(['a.md', 'b.md'])
    expect(getBitOverride(next, 'a.md')).toBe('reworked text')
    expect(getBitOverride(next, 'b.md')).toBeNull()
  })

  it('preserves an override body containing ::: joke blocks', () => {
    const body = 'intro\n:::joke 1\npunchline\n:::\noutro'
    const next = setBitOverride(base, 'b.md', body)
    expect(getBitOverride(next, 'b.md')).toBe(body)
    // The playlist still parses cleanly past the override block.
    expect(parseSet(next)).toEqual(['a.md', 'b.md'])
  })

  it('keeps multiple overrides independent', () => {
    let c = setBitOverride(base, 'a.md', 'AAA')
    c = setBitOverride(c, 'b.md', 'BBB')
    expect(getBitOverride(c, 'a.md')).toBe('AAA')
    expect(getBitOverride(c, 'b.md')).toBe('BBB')
  })

  it('updates an existing override in place', () => {
    const c = setBitOverride(setBitOverride(base, 'a.md', 'first'), 'a.md', 'second')
    expect(getBitOverride(c, 'a.md')).toBe('second')
    expect(getBitOverrides(c).size).toBe(1)
  })

  it('clears an override back to live text', () => {
    const c = setBitOverride(base, 'a.md', 'x')
    expect(getBitOverride(clearBitOverride(c, 'a.md'), 'a.md')).toBeNull()
  })

  it('drops the override when its bit is removed', () => {
    const c = setBitOverride(base, 'a.md', 'x')
    expect(getBitOverride(removeBitFromSet(c, 'a.md'), 'a.md')).toBeNull()
  })

  it('ignores an override whose bit is no longer in the set', () => {
    const orphan = `${base}\n:::setbit gone.md\nstale\n:::endbit\n`
    expect(getBitOverride(renderSet(parseSet(orphan)!), 'gone.md')).toBeNull()
  })

  it('only writes an override for a bit that is in the set', () => {
    expect(setBitOverride(base, 'missing.md', 'x')).toBe(base)
  })
})
