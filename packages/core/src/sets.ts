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

const SET_OPEN = ':::set'
const SET_CLOSE = ':::'

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

/** Render an ordered list of bit paths back into canonical set note content. */
export function renderSet(bits: string[]): string {
  return [SET_OPEN, ...bits, SET_CLOSE, ''].join('\n')
}

/** Add `path` to the set (no-op if already present), preserving order. */
export function addBitToSet(content: string, path: string): string {
  const bits = parseSet(content) ?? []
  if (bits.includes(path)) return content
  return renderSet([...bits, path])
}

/** Remove `path` from the set. Returns unchanged content if it wasn't there. */
export function removeBitFromSet(content: string, path: string): string {
  const bits = parseSet(content) ?? []
  if (!bits.includes(path)) return content
  return renderSet(bits.filter((b) => b !== path))
}

/** Swap the bit at `index` with its neighbour `dir` steps away (`-1` up, `+1`
 * down). Returns unchanged content when either position is out of range. */
export function moveBitInSet(content: string, index: number, dir: -1 | 1): string {
  const bits = parseSet(content) ?? []
  const j = index + dir
  if (index < 0 || index >= bits.length || j < 0 || j >= bits.length) return content
  const next = bits.slice()
  ;[next[index], next[j]] = [next[j], next[index]]
  return renderSet(next)
}
