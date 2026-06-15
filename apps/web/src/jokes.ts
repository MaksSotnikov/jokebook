// Jokes are stored inline in note text as a fenced block that rides the sync
// protocol as plain content (no schema/server changes). Shape:
//
//   :::joke 3
//   ...the bit, any markdown...
//   :::
//
// The number after `:::joke` is a 0–5 star rating (0 = unrated). The block is
// parsed out for the preview so the bit can be highlighted and rated.

const OPEN = /^:::joke[ \t]*([0-5])?[ \t]*$/
const CLOSE = /^:::[ \t]*$/

function strip(line: string): string {
  return line.replace(/\r$/, '')
}

interface ScannedJoke {
  open: number
  close: number
  stars: number
  body: string
}

/** Locate every well-formed (opened and closed) joke block, in order. */
function scan(lines: string[]): ScannedJoke[] {
  const out: ScannedJoke[] = []
  let i = 0
  while (i < lines.length) {
    const m = OPEN.exec(strip(lines[i]))
    if (m) {
      let j = i + 1
      while (j < lines.length && !CLOSE.test(strip(lines[j]))) j++
      if (j < lines.length) {
        out.push({ open: i, close: j, stars: m[1] ? Number(m[1]) : 0, body: lines.slice(i + 1, j).join('\n') })
        i = j + 1
        continue
      }
    }
    i++
  }
  return out
}

export interface TextSegment {
  type: 'text'
  value: string
}
export interface JokeSegment {
  type: 'joke'
  /** 0-based index among joke blocks; used to target rating updates. */
  index: number
  stars: number
  body: string
}
export type Segment = TextSegment | JokeSegment

/** Split note text into ordered text / joke segments for rendering. */
export function parseJokes(text: string): Segment[] {
  const lines = text.split('\n')
  const jokes = scan(lines)
  const segs: Segment[] = []
  let cursor = 0
  let index = 0
  for (const jk of jokes) {
    if (jk.open > cursor) segs.push({ type: 'text', value: lines.slice(cursor, jk.open).join('\n') })
    segs.push({ type: 'joke', index: index++, stars: jk.stars, body: jk.body })
    cursor = jk.close + 1
  }
  if (cursor < lines.length) segs.push({ type: 'text', value: lines.slice(cursor).join('\n') })
  return segs
}

/** Return note text with the `index`-th joke's rating set to `stars` (0–5). */
export function setJokeStars(text: string, index: number, stars: number): string {
  const lines = text.split('\n')
  const jokes = scan(lines)
  const jk = jokes[index]
  if (!jk) return text
  lines[jk.open] = `:::joke ${stars}`
  return lines.join('\n')
}

/** Wrap `selection` as a new (unrated) joke block, padding newlines so the
 * `:::` fences sit on their own lines within `before`/`after`. */
export function wrapJoke(before: string, selection: string, after: string): string {
  const body = selection.replace(/^\n+|\n+$/g, '')
  const block = `:::joke 0\n${body}\n:::`
  const lead = before && !before.endsWith('\n') ? '\n' : ''
  const trail = after && !after.startsWith('\n') ? '\n' : ''
  return `${before}${lead}${block}${trail}${after}`
}
