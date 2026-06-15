import { parseWikiLinks } from './parse.js'

/** Minimal note shape needed to build the link graph. */
export interface IndexedNote {
  id: string
  /** Vault-relative path, e.g. `"folder/My Note.md"`. */
  path: string
  content: string
}

/** Resolved link relationships across a set of notes. */
export interface LinkGraph {
  /** noteId → ids of notes it links to (resolved targets only). */
  outgoing: Map<string, Set<string>>
  /** noteId → ids of notes that link to it. */
  backlinks: Map<string, Set<string>>
  /** noteId → link targets that matched no existing note. */
  unresolved: Map<string, string[]>
}

/** Note name used for `[[wiki-link]]` resolution: basename without `.md`. */
export function noteName(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path
  return base.replace(/\.md$/i, '')
}

/** Normalize a link target / name for case-insensitive matching. */
function normalize(name: string): string {
  return name.trim().toLowerCase()
}

/**
 * Build a link graph from all notes. Links resolve by note name (Obsidian
 * style); a full relative path also resolves. The first note wins on a name
 * collision. Targets with no match are reported in `unresolved`.
 */
export function buildLinkGraph(notes: IndexedNote[]): LinkGraph {
  const byName = new Map<string, string>()
  const byPath = new Map<string, string>()
  for (const note of notes) {
    byPath.set(normalize(note.path), note.id)
    const name = normalize(noteName(note.path))
    if (!byName.has(name)) byName.set(name, note.id)
  }

  const outgoing = new Map<string, Set<string>>()
  const backlinks = new Map<string, Set<string>>()
  const unresolved = new Map<string, string[]>()
  for (const note of notes) {
    outgoing.set(note.id, new Set())
    backlinks.set(note.id, new Set())
  }

  for (const note of notes) {
    for (const link of parseWikiLinks(note.content)) {
      const key = normalize(link.target)
      const targetId = byName.get(key) ?? byPath.get(key) ?? byPath.get(`${key}.md`)
      if (!targetId) {
        const list = unresolved.get(note.id)
        if (list) list.push(link.target)
        else unresolved.set(note.id, [link.target])
        continue
      }
      if (targetId === note.id) continue // ignore self-links
      outgoing.get(note.id)!.add(targetId)
      backlinks.get(targetId)!.add(note.id)
    }
  }

  return { outgoing, backlinks, unresolved }
}
