import { useEffect, useRef } from 'react'
import { EditorView } from '@codemirror/view'
import { EditorState } from '@codemirror/state'
import type { CompletionContext, CompletionResult } from '@codemirror/autocomplete'
import { basicSetup } from 'codemirror'
import { markdown } from '@codemirror/lang-markdown'
import { wikiTagHighlight, wikiTagTheme } from '../lib/editorHighlight'

interface EditorProps {
  /** Current document text. Changing it (e.g. on note switch) replaces the doc. */
  value: string
  /** Fired on every edit with the new document text. */
  onChange: (value: string) => void
  /** Existing note names, used for `[[` autocompletion. */
  noteNames: string[]
}

/**
 * CodeMirror 6 markdown editor. The view is created once on mount; the `value`
 * prop only replaces the document when it differs from what the view already
 * holds, so typing (which flows out via `onChange`) never causes a re-sync loop.
 */
export function Editor({ value, onChange, noteNames }: EditorProps) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const namesRef = useRef(noteNames)
  namesRef.current = noteNames

  useEffect(() => {
    if (!host.current) return

    // Completion source for `[[` wiki-links. Registered through language data so
    // basicSetup's built-in autocompletion picks it up (no second instance).
    const wikiComplete = (ctx: CompletionContext): CompletionResult | null => {
      const before = ctx.matchBefore(/\[\[[^\]\n]*$/)
      if (!before) return null
      return {
        from: before.from + 2, // just after the `[[`
        options: namesRef.current.map((name) => ({
          label: name,
          type: 'text',
          apply: `${name}]]`,
        })),
        validFor: /[^\]\n]*/,
      }
    }

    const state = EditorState.create({
      doc: value,
      extensions: [
        basicSetup,
        markdown(),
        wikiTagHighlight,
        wikiTagTheme,
        EditorView.lineWrapping,
        EditorState.languageData.of(() => [{ autocomplete: wikiComplete }]),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) onChangeRef.current(u.state.doc.toString())
        }),
      ],
    })
    const v = new EditorView({ state, parent: host.current })
    view.current = v
    return () => {
      v.destroy()
      view.current = null
    }
    // Created once; doc updates are handled by the effect below.
  }, [])

  useEffect(() => {
    const v = view.current
    if (!v) return
    const current = v.state.doc.toString()
    if (current !== value) {
      v.dispatch({ changes: { from: 0, to: current.length, insert: value } })
    }
  }, [value])

  return <div className="editor" ref={host} />
}
