import {
  Decoration,
  EditorView,
  MatchDecorator,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view'
import { TAG_PATTERN } from '@notes/core'

const wikiDeco = Decoration.mark({ class: 'cm-wikilink' })
const tagDeco = Decoration.mark({ class: 'cm-hashtag' })

// One pass over the visible text marks both `[[wiki-links]]` and `#tags`; the
// alternation's first branch is the wiki-link, so a leading `[[` disambiguates.
const matcher = new MatchDecorator({
  regexp: new RegExp(`\\[\\[[^\\]\\n]+?\\]\\]|${TAG_PATTERN}`, 'gu'),
  decoration: (m) => (m[0].startsWith('[[') ? wikiDeco : tagDeco),
})

/** Live-highlight `[[wiki-links]]` and `#tags` in the editor (viewport only). */
export const wikiTagHighlight = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) {
      this.decorations = matcher.createDeco(view)
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged) {
        this.decorations = matcher.updateDeco(u, this.decorations)
      }
    }
  },
  { decorations: (v) => v.decorations },
)

/** Colours for the highlighted spans; mirrors the preview's link styling. */
export const wikiTagTheme = EditorView.baseTheme({
  '.cm-wikilink': { color: 'var(--accent)' },
  '.cm-hashtag': { color: 'var(--tag)' },
})
