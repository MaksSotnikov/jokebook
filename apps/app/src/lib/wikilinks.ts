import { noteName, TAG_PATTERN } from '@notes/core'

/** Matches `[[target]]` or `[[target|alias]]`. */
const WIKI_RE = /\[\[([^\]\n]+?)\]\]/g

/** Marked turns wiki-links into anchors with this href prefix; clicks on them
 * are intercepted in the preview to navigate to (or create) the note. */
export const WIKI_HREF_PREFIX = '#wl:'

/** Like {@link WIKI_HREF_PREFIX}, but for `#tag` anchors → filter by that tag. */
export const TAG_HREF_PREFIX = '#tag:'

/**
 * Rewrite `#tags` into markdown links pointing at `#tag:<encoded-tag>`, so the
 * preview renders clickable tag chips. Run this BEFORE {@link wikiLinksToMarkdown}:
 * the wiki transform emits `#wl:` hrefs that this regex would otherwise mangle.
 */
export function tagsToMarkdown(content: string): string {
  return content.replace(
    new RegExp(TAG_PATTERN, 'gu'),
    (whole, tag: string) => `[${whole}](${TAG_HREF_PREFIX}${encodeURIComponent(tag)})`,
  )
}

/** Decode a `#tag:` href back into the raw tag name. */
export function decodeTagHref(href: string): string | null {
  if (!href.startsWith(TAG_HREF_PREFIX)) return null
  return decodeURIComponent(href.slice(TAG_HREF_PREFIX.length))
}

/**
 * Rewrite `[[wiki-links]]` into normal markdown links pointing at
 * `#wl:<encoded-target>`, so the preview renderer produces clickable anchors.
 */
export function wikiLinksToMarkdown(content: string): string {
  return content.replace(WIKI_RE, (whole, inner: string) => {
    const pipe = inner.indexOf('|')
    const target = (pipe === -1 ? inner : inner.slice(0, pipe)).trim()
    if (!target) return whole
    const alias = (pipe === -1 ? target : inner.slice(pipe + 1).trim()) || target
    return `[${alias}](${WIKI_HREF_PREFIX}${encodeURIComponent(target)})`
  })
}

/** Decode a `#wl:` href back into the raw link target. */
export function decodeWikiHref(href: string): string | null {
  if (!href.startsWith(WIKI_HREF_PREFIX)) return null
  return decodeURIComponent(href.slice(WIKI_HREF_PREFIX.length))
}

/**
 * Resolve a link target to an existing note path (Obsidian-style: by note name
 * first, then by full relative path). Returns `null` if nothing matches.
 */
export function resolveTarget(target: string, paths: string[]): string | null {
  const key = target.trim().toLowerCase()
  for (const p of paths) {
    if (noteName(p).toLowerCase() === key) return p
  }
  for (const p of paths) {
    const pk = p.toLowerCase()
    if (pk === key || pk === `${key}.md`) return p
  }
  return null
}

/** Vault-relative path to use when creating a note from an unresolved target. */
export function targetToNewPath(target: string): string {
  const name = target.trim()
  return name.toLowerCase().endsWith('.md') ? name : `${name}.md`
}
