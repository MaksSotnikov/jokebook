// A "set" (стендап-сэт) is a snapshot playlist of jokes. The note is tagged as
// a set by an empty `:::set` header, and its body is then just a sequence of
// ordinary `:::joke` blocks — the jokes copied ("snapshotted") into the set:
//
//   :::set
//   :::
//
//   :::joke 4
//   the airport bit
//   :::
//
//   :::joke 5
//   the cats bit
//   :::
//
// Because the jokes are plain `:::joke` blocks, every joke helper (rate,
// reorder, remove, summarise, replace) works on set content directly — a set is
// just a note whose jokes are its running order and whose prose is dropped.
// The `:::set` header keeps {@link isSetNote} able to tell sets apart from
// regular notes (which may also contain jokes), and, like jokes and folders,
// the whole thing rides the sync protocol as plain content (no schema change).
// The note's filename is the set's name, so rename / delete reuse the ordinary
// note machinery.
//
// LEGACY: earlier sets listed member *bit paths* between the `:::set`/`:::`
// fences (one per line), optionally with per-bit `:::setbit … :::endbit`
// overrides, and composed their bits' live text at render time. Those readers
// live on below so a legacy set can be recognised ({@link isLegacySet}) and
// converted to the snapshot form ({@link migrateLegacySet}) on first open.

import { appendJokes, jokeBlocks } from './jokes.js'

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

// ── Snapshot joke sets (current model) ──────────────────────────────────────

const SET_HEADER = `${SET_OPEN}\n${SET_CLOSE}`

/** Render an ordered list of snapshot joke blocks into set note content: the
 * `:::set` header (so {@link isSetNote} recognises it) followed by the jokes as
 * plain `:::joke` blocks. An empty set is just the header. */
export function renderJokeSet(blocks: string[]): string {
  if (blocks.length === 0) return `${SET_HEADER}\n`
  return `${SET_HEADER}\n\n${blocks.join('\n\n')}\n`
}

/** The snapshot joke blocks that make up a set, in running order. (The `:::set`
 * header never parses as a joke, so this is exactly the set's jokes.) */
export function setJokeBlocks(content: string): string[] {
  return jokeBlocks(content)
}

/** Append snapshot joke `blocks` to a set, after any it already holds — the
 * `:::set` header is preserved. No-op for an empty `blocks`. */
export function addJokesToSet(content: string, blocks: string[]): string {
  return appendJokes(content, blocks)
}

/** True for a legacy (bit-path playlist) set that predates snapshot jokes: its
 * `:::set` block still lists note paths. New snapshot sets carry an empty
 * `:::set\n:::` header, so their bit list is empty and this is `false`. */
export function isLegacySet(content: string): boolean {
  const bits = parseSet(content)
  return bits !== null && bits.length > 0
}

/** Convert a legacy bit-path set into the snapshot form: pull the jokes out of
 * each referenced bit (a set-local override wins over the live note) and store
 * them inline, in playlist order. Prose around the jokes is dropped. `resolve`
 * returns the live content of a bit path, or `null` when it can't be found. */
export function migrateLegacySet(
  content: string,
  resolve: (path: string) => string | null,
): string {
  const bits = parseSet(content) ?? []
  const overrides = getBitOverrides(content)
  const blocks: string[] = []
  for (const path of bits) {
    const text = overrides.get(path) ?? resolve(path) ?? ''
    blocks.push(...jokeBlocks(text))
  }
  return renderJokeSet(blocks)
}
