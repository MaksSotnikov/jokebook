/** Opening code fence: ``` or ~~~ (3+), indented at most 3 spaces. */
const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})/
/** Closing code fence: a fence run and nothing but trailing whitespace. */
const FENCE_CLOSE_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/
/** A bullet-list marker (`-`, `*`, `+`) opening a line — possibly behind
 * blockquote `>` prefixes — followed by whitespace or the end of the line. */
const BULLET_RE = /^((?: {0,3}> ?)* {0,3})([-*+])(?=[ \t]|$)/
/** A thematic break (`- - -`, `* * *`, `___`…) — it must stay a rule. */
const THEMATIC_BREAK_RE = /^(?: {0,3}> ?)* {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/

/**
 * Backslash-escape bullet-list markers at the start of lines so markdown
 * renders them as the characters the user typed: a dialogue line `- Привет!`
 * stays `- Привет!` instead of becoming a `•` list item. Code fences,
 * thematic breaks (`- - -`) and numbered lists are left alone.
 *
 * Render with GFM `breaks` on, or consecutive `- …` lines would merge into one
 * line once they are no longer list items.
 */
export function escapeListBullets(text: string): string {
  let fence: string | null = null
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => {
      if (fence) {
        const close = FENCE_CLOSE_RE.exec(line)
        if (close && close[1][0] === fence[0] && close[1].length >= fence.length) fence = null
        return line
      }
      const open = FENCE_OPEN_RE.exec(line)
      // A backtick fence's info string can't itself contain a backtick.
      if (open && (open[1][0] === '~' || !line.slice(open[0].length).includes('`'))) {
        fence = open[1]
        return line
      }
      if (THEMATIC_BREAK_RE.test(line)) return line
      return line.replace(BULLET_RE, '$1\\$2')
    })
    .join('\n')
}
