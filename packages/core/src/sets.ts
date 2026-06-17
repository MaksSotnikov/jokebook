// A "set" (стендап-сэт) is an ordered playlist of bits — regular notes that
// hold jokes. Like jokes and folders, a set rides the sync protocol as plain
// note content (no schema/server changes): the note's whole body is a single
// fenced block listing the member bit paths, one per line:
//
//   :::set
//   bits/airport.md
//   bits/cats.md
//   :::
//
// The note's filename is the set's name, so renaming / deleting a set reuses
// the ordinary note rename / delete machinery. The bodies of the referenced
// bits are composed live for the running order, so a set always reflects the
// current text of its bits.
//
// A set may also carry per-bit *overrides*: tweaked text the comedian wants for
// this set only, without touching the original bit note. Each override is a
// fenced block appended after the playlist:
//
//   :::setbit bits/airport.md
//   <reworked text for this set>
//   :::endbit
//
// When composing the running order the override text wins over the live bit;
// the original note is never modified. Overrides ride the same plain-content
// sync, so they propagate everywhere with no protocol change.

const SET_OPEN = ':::set'
const SET_CLOSE = ':::'
const OVERRIDE_OPEN = ':::setbit'
// A distinctive close marker so an override body can itself contain `:::`
// (e.g. joke blocks) without prematurely ending the block.
const OVERRIDE_CLOSE = ':::endbit'

function strip(line: string): string {
  return line.replace(/\r$/, '')
}

/** Parse a set note into its ordered bit paths, or `null` if `content` is not a
 * set (its first non-blank line isn't the `:::set` marker). */
export function parseSet(content: string): string[] | null {
  const lines = content.split('\n').map(strip)
  const first = lines.findIndex((l) => l.trim() !== '')
  if (first === -1 || lines[first].trim() !== SET_OPEN) return null
  const bits: string[] = []
  for (let i = first + 1; i < lines.length; i++) {
    const t = lines[i].trim()
    if (t === SET_CLOSE) break
    if (t) bits.push(t)
  }
  return bits
}

/** True when `content` is a set note (vs. a regular bit / note). */
export function isSetNote(content: string): boolean {
  return parseSet(content) !== null
}

/** Read every per-bit override in the set, keyed by bit path (insertion order
 * preserved). Returns an empty map for sets with no overrides. */
export function getBitOverrides(content: string): Map<string, string> {
  const lines = content.split('\n').map(strip)
  const map = new Map<string, string>()
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim()
    if (!t.startsWith(`${OVERRIDE_OPEN} `)) continue
    const path = t.slice(OVERRIDE_OPEN.length).trim()
    const body: string[] = []
    i++
    for (; i < lines.length && lines[i].trim() !== OVERRIDE_CLOSE; i++) body.push(lines[i])
    if (path) map.set(path, body.join('\n'))
  }
  return map
}

/** The override text for `path`, or `null` when the bit uses its live note text. */
export function getBitOverride(content: string, path: string): string | null {
  const ov = getBitOverrides(content)
  return ov.has(path) ? (ov.get(path) as string) : null
}

/** Serialise an ordered bit list + override map into canonical set content. */
function compose(bits: string[], overrides: Map<string, string>): string {
  const parts: string[] = [SET_OPEN, ...bits, SET_CLOSE]
  for (const [path, body] of overrides) {
    if (!bits.includes(path)) continue // never persist orphan overrides
    parts.push('', `${OVERRIDE_OPEN} ${path}`, ...body.split('\n'), OVERRIDE_CLOSE)
  }
  parts.push('')
  return parts.join('\n')
}

/** Render an ordered list of bit paths back into canonical set note content. */
export function renderSet(bits: string[]): string {
  return compose(bits, new Map())
}

/** Add `path` to the set (no-op if already present), preserving order + overrides. */
export function addBitToSet(content: string, path: string): string {
  const bits = parseSet(content) ?? []
  if (bits.includes(path)) return content
  return compose([...bits, path], getBitOverrides(content))
}

/** Remove `path` from the set (and drop any override it had). Returns unchanged
 * content if it wasn't there. */
export function removeBitFromSet(content: string, path: string): string {
  const bits = parseSet(content) ?? []
  if (!bits.includes(path)) return content
  const overrides = getBitOverrides(content)
  overrides.delete(path)
  return compose(
    bits.filter((b) => b !== path),
    overrides,
  )
}

/** Swap the bit at `index` with its neighbour `dir` steps away (`-1` up, `+1`
 * down). Returns unchanged content when either position is out of range. */
export function moveBitInSet(content: string, index: number, dir: -1 | 1): string {
  const bits = parseSet(content) ?? []
  const j = index + dir
  if (index < 0 || index >= bits.length || j < 0 || j >= bits.length) return content
  const next = bits.slice()
  ;[next[index], next[j]] = [next[j], next[index]]
  return compose(next, getBitOverrides(content))
}

/** Store `body` as the set-local text for `path` (no-op if the bit isn't in the
 * set). The original bit note is untouched — the override lives in the set. */
export function setBitOverride(content: string, path: string, body: string): string {
  const bits = parseSet(content) ?? []
  if (!bits.includes(path)) return content
  const overrides = getBitOverrides(content)
  overrides.set(path, body)
  return compose(bits, overrides)
}

/** Drop the override for `path`, reverting the bit to its live note text. */
export function clearBitOverride(content: string, path: string): string {
  const bits = parseSet(content) ?? []
  const overrides = getBitOverrides(content)
  if (!overrides.delete(path)) return content
  return compose(bits, overrides)
}
