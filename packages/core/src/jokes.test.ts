import { describe, expect, it } from 'vitest'
import {
  addJokeVersion,
  jokeSetSeconds,
  moveJoke,
  parseJokes,
  performedVersion,
  removeJokeVersion,
  setVersionStars,
  wordCount,
  wrapJoke,
  type JokeSegment,
} from './jokes.js'

const jokeSegs = (text: string) =>
  parseJokes(text).filter((s): s is JokeSegment => s.type === 'joke')

describe('parseJokes', () => {
  it('splits text and a single-version joke in order', () => {
    const segs = parseJokes('intro\n:::joke 3\nthe bit\n:::\noutro')
    expect(segs).toEqual([
      { type: 'text', value: 'intro' },
      { type: 'joke', index: 0, versions: [{ stars: 3, body: 'the bit' }] },
      { type: 'text', value: 'outro' },
    ])
  })

  it('treats a missing rating as 0 (unrated)', () => {
    expect(jokeSegs(':::joke\nbit\n:::')[0].versions[0].stars).toBe(0)
  })

  it('parses multiple versions with independent ratings', () => {
    const segs = jokeSegs(':::joke 2\nfirst\n:::alt 5\nsecond\n:::alt\nthird\n:::')
    expect(segs[0].versions).toEqual([
      { stars: 2, body: 'first' },
      { stars: 5, body: 'second' },
      { stars: 0, body: 'third' },
    ])
  })

  it('keeps multi-line bodies intact', () => {
    expect(jokeSegs(':::joke 1\nline a\nline b\n:::')[0].versions[0].body).toBe('line a\nline b')
  })

  it('ignores an unclosed block', () => {
    expect(jokeSegs(':::joke 3\ndangling')).toHaveLength(0)
  })
})

describe('setVersionStars', () => {
  const text = ':::joke 2\nfirst\n:::alt 1\nsecond\n:::'

  it('rates the original version', () => {
    expect(jokeSegs(setVersionStars(text, 0, 0, 5))[0].versions[0].stars).toBe(5)
  })

  it('rates an alternative version without touching the original', () => {
    const out = jokeSegs(setVersionStars(text, 0, 1, 4))[0].versions
    expect(out.map((v) => v.stars)).toEqual([2, 4])
  })

  it('leaves text unchanged for an unknown version', () => {
    expect(setVersionStars(text, 0, 9, 5)).toBe(text)
  })
})

describe('addJokeVersion', () => {
  it('appends a blank unrated version and points the caret at it', () => {
    const { text, caret } = addJokeVersion(':::joke 3\nthe bit\n:::', 0)
    const versions = jokeSegs(text)[0].versions
    expect(versions).toEqual([
      { stars: 3, body: 'the bit' },
      { stars: 0, body: '' },
    ])
    // Caret lands at the start of the freshly-inserted blank body line,
    // which is followed by the empty line and the closing fence.
    expect(text.slice(caret - 9, caret - 1)).toBe(':::alt 0')
    expect(text.slice(caret)).toBe('\n:::')
  })

  it('adds versions only to the targeted joke', () => {
    const src = ':::joke 1\na\n:::\n\n:::joke 2\nb\n:::'
    const segs = jokeSegs(addJokeVersion(src, 1).text)
    expect(segs[0].versions).toHaveLength(1)
    expect(segs[1].versions).toHaveLength(2)
  })
})

describe('removeJokeVersion', () => {
  const text = ':::joke 2\nfirst\n:::alt 5\nsecond\n:::alt 1\nthird\n:::'

  it('drops a middle version', () => {
    const v = jokeSegs(removeJokeVersion(text, 0, 1))[0].versions
    expect(v).toEqual([
      { stars: 2, body: 'first' },
      { stars: 1, body: 'third' },
    ])
  })

  it('promotes the next version when the original is removed', () => {
    const v = jokeSegs(removeJokeVersion(text, 0, 0))[0].versions
    expect(v).toEqual([
      { stars: 5, body: 'second' },
      { stars: 1, body: 'third' },
    ])
  })

  it('never removes a joke’s only version', () => {
    const solo = ':::joke 3\nonly\n:::'
    expect(removeJokeVersion(solo, 0, 0)).toBe(solo)
  })
})

describe('moveJoke', () => {
  it('swaps adjacent multi-version jokes, keeping interleaved text', () => {
    const src = ':::joke 1\nA\n:::alt 2\nA2\n:::\nmid\n:::joke 3\nB\n:::'
    const out = moveJoke(src, 0, 1)
    const segs = jokeSegs(out)
    expect(segs[0].versions[0].body).toBe('B')
    expect(segs[1].versions.map((v) => v.body)).toEqual(['A', 'A2'])
    expect(out).toContain('\nmid\n')
  })
})

describe('wrapJoke', () => {
  it('wraps a selection as a fresh unrated joke', () => {
    expect(wrapJoke('a\n', 'punch', '\nb')).toBe('a\n:::joke 0\npunch\n:::\nb')
  })
})

describe('timing', () => {
  it('counts words', () => {
    expect(wordCount('  one  two three ')).toBe(3)
    expect(wordCount('   ')).toBe(0)
  })

  it('performs the highest-rated version, ties to the original', () => {
    expect(performedVersion([{ stars: 2, body: 'a' }, { stars: 2, body: 'b' }]).body).toBe('a')
    expect(performedVersion([{ stars: 1, body: 'a' }, { stars: 4, body: 'b' }]).body).toBe('b')
  })

  it('times the set from each joke’s best version at 150 wpm', () => {
    // joke 1 best version = 150 words → 60s; joke 2 = 75 words → 30s.
    const big = Array(150).fill('w').join(' ')
    const small = Array(75).fill('w').join(' ')
    const segs = jokeSegs(`:::joke 1\nlo\n:::alt 5\n${big}\n:::\n:::joke 2\n${small}\n:::`)
    expect(Math.round(jokeSetSeconds(segs))).toBe(90)
  })
})
