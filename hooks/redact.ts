// What a prompt looks like before it goes to TypeSafe. Jev only judges how much effort a request
// needs, so it never needs the code, the credentials or where things live. Pastes and code become
// a short note of their size, credentials, links, addresses and absolute paths become a tag, and a
// long prompt keeps its opening and its end. Short identifiers and relative paths are left alone:
// they say what kind of work it is. Pattern-based, so an unusual secret format can still get
// through; nothing here leaves the machine until this has run.

/** How much of a long prompt's opening and end is kept. */
export const KEEP_START = 3000
export const KEEP_END = 1000

type Mask = [pattern: RegExp, replacement: string | ((match: string) => string)]

const lines = (block: string): number => Math.max(1, block.split('\n').length - 2)

// Order matters: whole blocks first, then credentials (which can sit inside links or paths), then
// the things that say where something lives.
const MASKS: Mask[] = [
  [/<pasted_content id="([^"]*)">[\s\S]*?<\/pasted_content id="\1">/g, (m) => `[pasted text: ${m.replace(/^<pasted_content[^>]*>\n?|\n?<\/pasted_content[^>]*>$/g, '').length} chars]`],
  [/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?(^\1[ \t]*$|(?![\s\S]))/gm, (m) => `[code: ${lines(m)} lines]`],
  [/-----BEGIN [A-Z0-9 ]+-----[\s\S]*?(-----END [A-Z0-9 ]+-----|(?![\s\S]))/g, '<secret>'],
  [/`[^`\n]{40,}`/g, '[code]'],
  [/\b((?:pass(?:word|wd)?|pwd|secret|token|(?:api|access|private)[_-]?key|client[_-]?secret)\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|\S+)/gi, '$1<secret>'],
  [/\b(?:sk|pk|rk)-[\w-]{16,}/g, '<secret>'],
  [/\b(?:gh[opsur]_\w{20,}|github_pat_\w{20,})/g, '<secret>'],
  [/\bxox[abprs]-[\w-]{10,}/g, '<secret>'],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, '<secret>'],
  [/\bAIza[\w-]{30,}/g, '<secret>'],
  [/\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{4,}/g, '<secret>'],
  [/\b[a-z][a-z0-9+.-]{1,15}:\/\/[^\s<>"'`)\]]+/gi, '<url>'],
  [/\b[\w.%+-]+@[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}\b/gi, '<email>'],
  [/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d{1,5})?\b/g, '<ip>'],
  [/\b[a-z]:\\[^\s"'`]*/gi, '<path>'],
  [/(?<![\w./~<>@-])(?:~|\.\.?)?\/(?:[\w.@+-]+\/)+[\w.@+-]*/g, '<path>'],
  [/(?<![\w./~<>-])~\/[\w.@+-]+/g, '<path>'],
  [/\b[0-9a-f]{32,}\b/gi, '<secret>'],
  // A long unbroken run of letters and digits mixed: a key, token or signature.
  [/(?<![\w+-])(?=[\w+-]*\d)(?=[\w+-]*[a-z])[\w+-]{40,}={0,2}(?![\w+-])/gi, '<secret>'],
]

/** The prompt with every mask applied, and how many matches were masked. */
export function mask(text: string): { text: string; masked: number } {
  let masked = 0
  let out = text
  for (const [pattern, replacement] of MASKS) {
    out = out.replace(pattern, (...args: unknown[]) => {
      masked++
      const match = args[0] as string
      if (typeof replacement === 'function') return replacement(match)
      return replacement.replace('$1', typeof args[1] === 'string' ? args[1] : '')
    })
  }
  return { text: out, masked }
}

/** A long prompt cut to its opening and its end, with a note of how much was left out. */
export function shorten(text: string, start = KEEP_START, end = KEEP_END): string {
  if (text.length <= start + end) return text
  return `${text.slice(0, start)}\n[${text.length - start - end} chars left out]\n${text.slice(-end)}`
}

/**
 * The prompt as Jev may see it, or `undefined` when there is nothing to score: an empty prompt, or
 * a slash command, which sets its own effort if it wants one.
 */
export function promptForJev(raw: string | undefined): string | undefined {
  const text = (raw ?? '').trim()
  if (!text || text.startsWith('/')) return undefined
  const masked = mask(text).text.trim()
  return masked ? shorten(masked) : undefined
}
