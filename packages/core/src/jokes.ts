// Jokes are stored inline in note text as a fenced block that rides the sync
// protocol as plain content (no schema/server changes). Shape:
//
//   :::joke 3
//   ...the bit, any markdown...
//   :::alt 5
//   ...an alternative phrasing of the same bit...
//   :::
//
// The number after `:::joke` / `:::alt` is a 0–5 star rating (0 = unrated).
// A joke always has at least one version (the `:::joke` opener); each `:::alt`
// marker starts an additional, independently-rated version of the same joke.
// Single-version jokes (no `:::alt`) are the common case and stay byte-for-byte
// compatible with notes written before versions existed.

const OPEN = /^:::joke[ \t]*([0-5])?[ \t]*$/
const ALT = /^:::alt[ \t]*([0-5])?[ \t]*$/
const CLOSE = /^:::[ \t]*$/

function strip(line: string): string {
  return line.replace(/\r$/, '')
}

/** One phrasing of a joke, with its own star rating (0 = unrated). */
export interface JokeVersion {
  stars: number
  body: string
}

interface ScannedJoke {
  open: number
  close: number
  versions: JokeVersion[]
  /** Source line of each version's marker (`:::joke` for v0, `:::alt` for the rest). */
  markerLines: number[]
}

/** Locate every well-formed (opened and closed) joke block, in order. */
function scan(lines: string[]): ScannedJoke[] {
  const out: ScannedJoke[] = []
  let i = 0
  while (i < lines.length) {
    const m = OPEN.exec(strip(lines[i]))
    if (m) {
      const versions: JokeVersion[] = []
      const markerLines: number[] = [i]
      let curStars = m[1] ? Number(m[1]) : 0
      let bodyStart = i + 1
      let j = i + 1
      while (j < lines.length && !CLOSE.test(strip(lines[j]))) {
        const a = ALT.exec(strip(lines[j]))
        if (a) {
          versions.push({ stars: curStars, body: lines.slice(bodyStart, j).join('\n') })
          markerLines.push(j)
          curStars = a[1] ? Number(a[1]) : 0
          bodyStart = j + 1
        }
        j++
      }
      if (j < lines.length) {
        versions.push({ stars: curStars, body: lines.slice(bodyStart, j).join('\n') })
        out.push({ open: i, close: j, versions, markerLines })
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
  /** 0-based index among joke blocks; used to target rating/version updates. */
  index: number
  versions: JokeVersion[]
  /** The raw `:::joke … :::` block text, verbatim — used to copy the joke. */
  source: string
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
    if (jk.open > cursor)
      segs.push({ type: 'text', value: lines.slice(cursor, jk.open).join('\n') })
    segs.push({
      type: 'joke',
      index: index++,
      versions: jk.versions,
      source: lines.slice(jk.open, jk.close + 1).join('\n'),
    })
    cursor = jk.close + 1
  }
  if (cursor < lines.length) segs.push({ type: 'text', value: lines.slice(cursor).join('\n') })
  return segs
}

/** Render one or more versions back into a `:::joke … :::` block. */
function renderBlock(versions: JokeVersion[]): string[] {
  const out: string[] = []
  versions.forEach((v, i) => {
    out.push(`${i === 0 ? ':::joke' : ':::alt'} ${v.stars}`)
    if (v.body.length > 0) out.push(...v.body.split('\n'))
  })
  out.push(':::')
  return out
}

/** Return note text with version `versionIndex` of joke `jokeIndex` rated
 * `stars` (0–5). Unknown indices leave the text unchanged. */
export function setVersionStars(
  text: string,
  jokeIndex: number,
  versionIndex: number,
  stars: number,
): string {
  const lines = text.split('\n')
  const jk = scan(lines)[jokeIndex]
  const marker = jk?.markerLines[versionIndex]
  if (marker === undefined) return text
  lines[marker] = `${versionIndex === 0 ? ':::joke' : ':::alt'} ${stars}`
  return lines.join('\n')
}

/** Append a new empty (unrated) version to joke `jokeIndex`. Returns the new
 * text plus the caret offset of the blank version body, so the caller can drop
 * the user into edit mode ready to type the alternative. */
export function addJokeVersion(text: string, jokeIndex: number): { text: string; caret: number } {
  const lines = text.split('\n')
  const jk = scan(lines)[jokeIndex]
  if (!jk) return { text, caret: text.length }
  // Insert `:::alt 0` and a blank body line just before the closing `:::`.
  const next = [...lines.slice(0, jk.close), ':::alt 0', '', ...lines.slice(jk.close)]
  // Caret sits at the start of the blank body line (index jk.close + 1).
  const caret = next.slice(0, jk.close + 1).join('\n').length + 1
  return { text: next.join('\n'), caret }
}

/** Remove version `versionIndex` from joke `jokeIndex`. A joke's only version
 * is never removed (delete the bit by editing instead). */
export function removeJokeVersion(text: string, jokeIndex: number, versionIndex: number): string {
  const lines = text.split('\n')
  const jk = scan(lines)[jokeIndex]
  if (!jk || jk.versions.length <= 1 || !jk.versions[versionIndex]) return text
  const kept = jk.versions.filter((_, i) => i !== versionIndex)
  const block = renderBlock(kept)
  return [...lines.slice(0, jk.open), ...block, ...lines.slice(jk.close + 1)].join('\n')
}

/** Swap the `index`-th joke block with its neighbour `dir` steps away
 * (`-1` = previous, `+1` = next), leaving any interleaved text in place.
 * Returns the text unchanged if either joke is out of range. */
export function moveJoke(text: string, index: number, dir: -1 | 1): string {
  const lines = text.split('\n')
  const jokes = scan(lines)
  const a = jokes[index]
  const b = jokes[index + dir]
  if (!a || !b) return text
  // Work in document order so the slice math holds regardless of `dir`.
  const [first, second] = a.open < b.open ? [a, b] : [b, a]
  const swapped = [
    ...lines.slice(0, first.open),
    ...lines.slice(second.open, second.close + 1),
    ...lines.slice(first.close + 1, second.open),
    ...lines.slice(first.open, first.close + 1),
    ...lines.slice(second.close + 1),
  ]
  return swapped.join('\n')
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

/** Append joke `blocks` to the end of `target` note content, separated by a
 * blank line, normalising trailing whitespace so the fences stay well-formed.
 * Returns `target` unchanged when there are no blocks. */
export function appendJokes(target: string, blocks: string[]): string {
  if (blocks.length === 0) return target
  const added = blocks.join('\n\n')
  const base = target.replace(/\s+$/, '')
  return base ? `${base}\n\n${added}\n` : `${added}\n`
}

/** Count whitespace-delimited words in a chunk of text. */
export function wordCount(text: string): number {
  const trimmed = text.trim()
  return trimmed ? trimmed.split(/\s+/).length : 0
}

/** The version a comic would actually perform: the highest-rated one, ties
 * broken by document order (so the original wins a tie). Falls back to the
 * first version when nothing is rated. */
export function performedVersion(versions: JokeVersion[]): JokeVersion {
  return versions.reduce((best, v) => (v.stars > best.stars ? v : best), versions[0])
}

/** Words a comic per minute reads at a typical stand-up delivery pace. */
export const WORDS_PER_MINUTE = 150

/** Estimated stage time, in seconds, for a set of jokes — summing the words of
 * each joke's performed (best-rated) version at {@link WORDS_PER_MINUTE}. */
export function jokeSetSeconds(jokes: JokeSegment[]): number {
  const words = jokes.reduce((sum, j) => sum + wordCount(performedVersion(j.versions).body), 0)
  return (words / WORDS_PER_MINUTE) * 60
}

/** Tally of a note's jokes for the end-of-note / set summaries. Ratings and
 * timing use each joke's performed (best) version; the average is over the
 * jokes that carry any rating. */
export interface JokeSummary {
  count: number
  rated: number
  avg: number | null
  seconds: number
}

/** Summarise the jokes in a chunk of note text. */
export function jokeSummary(text: string): JokeSummary {
  const jokes = parseJokes(text).filter((s): s is JokeSegment => s.type === 'joke')
  const best = jokes.map((j) => performedVersion(j.versions).stars)
  const rated = best.filter((s) => s > 0)
  const avg = rated.length ? rated.reduce((sum, s) => sum + s, 0) / rated.length : null
  return { count: jokes.length, rated: rated.length, avg, seconds: jokeSetSeconds(jokes) }
}
