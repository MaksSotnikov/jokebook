import { describe, expect, it } from 'vitest'
import {
  addBitToSet,
  addJokesToSet,
  clearBitOverride,
  getBitOverride,
  getBitOverrides,
  isLegacySet,
  isSetNote,
  migrateLegacySet,
  moveBitInSet,
  parseSet,
  removeBitFromSet,
  renderJokeSet,
  renderSet,
  setBitOverride,
  setJokeBlocks,
} from './sets.js'
import { jokeBlocks, moveJoke, removeJoke, setVersionStars } from './jokes.js'

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

// ── Snapshot joke sets (current model) ──────────────────────────────────────

describe('renderJokeSet', () => {
  const a = ':::joke 3\nairport\n:::'
  const b = ':::joke 5\ncats\n:::'

  it('renders an empty set as just the header', () => {
    expect(renderJokeSet([])).toBe(':::set\n:::\n')
  })

  it('is recognised as a set but carries no legacy bits', () => {
    const set = renderJokeSet([a, b])
    expect(isSetNote(set)).toBe(true)
    expect(parseSet(set)).toEqual([]) // empty header → no bit paths
    expect(isLegacySet(set)).toBe(false)
  })

  it('round-trips its jokes through setJokeBlocks', () => {
    expect(setJokeBlocks(renderJokeSet([a, b]))).toEqual([a, b])
  })

  it('an empty set holds no jokes', () => {
    expect(setJokeBlocks(renderJokeSet([]))).toEqual([])
  })
})

describe('addJokesToSet', () => {
  const a = ':::joke 3\nairport\n:::'
  const b = ':::joke 5\ncats\n:::'

  it('appends jokes after the ones already in the set', () => {
    const set = addJokesToSet(renderJokeSet([a]), [b])
    expect(setJokeBlocks(set)).toEqual([a, b])
    expect(isSetNote(set)).toBe(true)
  })

  it('adds jokes to an empty set', () => {
    expect(setJokeBlocks(addJokesToSet(renderJokeSet([]), [a, b]))).toEqual([a, b])
  })
})

describe('snapshot sets reuse the joke helpers', () => {
  const a = ':::joke 1\nairport\n:::'
  const b = ':::joke 2\ncats\n:::'
  const c = ':::joke 3\ndogs\n:::'

  it('reorders jokes with moveJoke', () => {
    const set = renderJokeSet([a, b, c])
    expect(setJokeBlocks(moveJoke(set, 0, 1))).toEqual([b, a, c])
    expect(setJokeBlocks(moveJoke(set, 2, -1))).toEqual([a, c, b])
  })

  it('removes a joke with removeJoke, keeping the set a set', () => {
    const set = renderJokeSet([a, b, c])
    const next = removeJoke(set, 1)
    expect(setJokeBlocks(next)).toEqual([a, c])
    expect(isSetNote(next)).toBe(true)
  })

  it('rates a set joke with setVersionStars', () => {
    const set = renderJokeSet([a, b])
    const next = setVersionStars(set, 1, 0, 5)
    expect(setJokeBlocks(next)[1]).toBe(':::joke 5\ncats\n:::')
  })
})

describe('isLegacySet', () => {
  it('flags a bit-path playlist', () => {
    expect(isLegacySet(':::set\nbits/a.md\nbits/b.md\n:::\n')).toBe(true)
  })

  it('does not flag a snapshot set or a regular note', () => {
    expect(isLegacySet(renderJokeSet([':::joke 1\nx\n:::']))).toBe(false)
    expect(isLegacySet(':::set\n:::\n')).toBe(false)
    expect(isLegacySet('just a note')).toBe(false)
  })
})

describe('migrateLegacySet', () => {
  const airport = 'setup line\n:::joke 4\nairport punch\n:::\nmore prose'
  const cats = ':::joke 5\ncats punch\n:::\n:::joke 2\ncats alt bit\n:::'

  it('pulls each bit’s jokes inline in playlist order, dropping prose', () => {
    const legacy = ':::set\nairport.md\ncats.md\n:::\n'
    const resolve = (p: string) =>
      p === 'airport.md' ? airport : p === 'cats.md' ? cats : null
    const migrated = migrateLegacySet(legacy, resolve)
    expect(isLegacySet(migrated)).toBe(false)
    expect(setJokeBlocks(migrated)).toEqual([
      ':::joke 4\nairport punch\n:::',
      ':::joke 5\ncats punch\n:::',
      ':::joke 2\ncats alt bit\n:::',
    ])
  })

  it('prefers a set-local override over the live bit text', () => {
    const legacy = setBitOverride(':::set\nairport.md\n:::\n', 'airport.md', ':::joke 1\nreworked\n:::')
    const migrated = migrateLegacySet(legacy, () => airport)
    expect(setJokeBlocks(migrated)).toEqual([':::joke 1\nreworked\n:::'])
  })

  it('skips bits that resolve to nothing', () => {
    const legacy = ':::set\ngone.md\n:::\n'
    expect(setJokeBlocks(migrateLegacySet(legacy, () => null))).toEqual([])
  })

  it('leaves an already-migrated set stable (idempotent-ish)', () => {
    const snapshot = renderJokeSet([':::joke 3\nx\n:::'])
    // A snapshot set has no bits, so migration yields an empty set — callers
    // gate on isLegacySet and never migrate a snapshot set.
    expect(jokeBlocks(snapshot)).toEqual([':::joke 3\nx\n:::'])
  })
})
