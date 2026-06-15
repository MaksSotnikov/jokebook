import matter from 'gray-matter'

/** A single `[[wiki-link]]` (optionally `[[target|alias]]`) found in note text. */
export interface WikiLink {
  /** Linked note name, e.g. `"My Note"`. */
  target: string
  /** Display text after a pipe, if present: `[[target|alias]]`. */
  alias?: string
  /** Character offset where the link starts in the source. */
  start: number
  /** Character offset just past the end of the link. */
  end: number
}

/** Result of parsing a raw markdown note. */
export interface ParsedNote {
  /** YAML frontmatter as a plain object (empty if none). */
  frontmatter: Record<string, unknown>
  /** Note body with frontmatter stripped. */
  body: string
  /** All `[[wiki-links]]` in the body, in document order. */
  wikiLinks: WikiLink[]
  /** Distinct `#tags` in the body (without the leading `#`). */
  tags: string[]
}

const WIKI_LINK_RE = /\[\[([^\]\n]+?)\]\]/g
/**
 * Source pattern for a `#tag` (capture group 1 = the tag without `#`). A tag
 * starts at a word boundary, then `#`, then tag chars. Unicode-aware so
 * non-Latin tags work; excludes a digit-leading tag (e.g. issue refs `#123`).
 * Exported so the editor highlighter and preview share one definition — use
 * `new RegExp(TAG_PATTERN, 'gu')` at the call site (don't reuse a global one
 * across `.replace`/`.matchAll`, whose `lastIndex` would carry over).
 */
export const TAG_PATTERN = '(?<![\\p{L}\\p{N}_/])#([\\p{L}_][\\p{L}\\p{N}_/-]*)'

/** Extract all `[[wiki-links]]` from text. */
export function parseWikiLinks(content: string): WikiLink[] {
  const links: WikiLink[] = []
  for (const match of content.matchAll(WIKI_LINK_RE)) {
    const inner = match[1]
    const pipe = inner.indexOf('|')
    const target = (pipe === -1 ? inner : inner.slice(0, pipe)).trim()
    if (!target) continue
    const alias = pipe === -1 ? undefined : inner.slice(pipe + 1).trim() || undefined
    links.push({
      target,
      alias,
      start: match.index,
      end: match.index + match[0].length,
    })
  }
  return links
}

/** Extract distinct `#tags` from text (leading `#` removed). */
export function parseTags(content: string): string[] {
  const tags = new Set<string>()
  for (const match of content.matchAll(new RegExp(TAG_PATTERN, 'gu'))) {
    tags.add(match[1])
  }
  return [...tags]
}

/** Parse a raw markdown note into frontmatter, body, links and tags. */
export function parseNote(raw: string): ParsedNote {
  const { data, content } = matter(raw)
  return {
    frontmatter: data as Record<string, unknown>,
    body: content,
    wikiLinks: parseWikiLinks(content),
    tags: parseTags(content),
  }
}
