/**
 * Pure parser for the `/deep-research` command line. Leaf module: no
 * dependencies, no I/O — unit-testable without a host (tests/command.spec.mjs).
 *
 * Grammar (everything after the command name, verbatim from the composer):
 *   <topic> [--depth 1-3] [--purpose "..."] [--no-verify] [--no-synthesize] [--review] [--foreground]
 *
 * Flags may appear anywhere; the remaining text (whitespace-collapsed) is the
 * topic. Defaults mirror the tool face: depth 2, synthesize on, verify on,
 * review off, background on (`--foreground` flips it).
 *
 * @module dsh-deep-research/command
 */

/** One parsed user request, ready for the shared execution core. */
export interface ResearchCommandRequest {
  /** Whitespace-collapsed remaining text; non-empty on ok. */
  readonly topic: string
  /** Present exactly when a non-empty `--purpose "…"` was supplied. */
  readonly purpose?: string
  /** Parsed depth; defaults to 2. */
  readonly depth: number
  /** `--no-synthesize` flips this off. */
  readonly synthesize: boolean
  /** `--no-verify` flips this off. */
  readonly verify: boolean
  /** `--review` flips this on. */
  readonly review: boolean
  /** `--foreground` runs in the foreground instead of the default background. */
  readonly foreground: boolean
}

export type ParseResearchResult =
  | { ok: true; request: ResearchCommandRequest }
  | { ok: false; error: string }

const USAGE =
  '用法：/deep-research <主题> [--depth 1-3] [--purpose "…"] [--no-verify] [--no-synthesize] [--review] [--foreground]'

/** One recognized boolean flag and the request field it flips. */
const BOOL_FLAGS = [
  ['--no-verify', 'noVerify'],
  ['--no-synthesize', 'noSynthesize'],
  ['--review', 'review'],
  ['--foreground', 'foreground'],
] as const

type BoolFlagKey = (typeof BOOL_FLAGS)[number][1]

/**
 * Parse one command line into a research request.
 * @param rawInput - verbatim text after the command name (may be empty).
 * @returns the request, or a human-readable error (usage included).
 */
export function parseResearchCommand(rawInput: string): ParseResearchResult {
  const flags: Record<BoolFlagKey, boolean> = {
    noVerify: false,
    noSynthesize: false,
    review: false,
    foreground: false,
  }
  let depth: number | undefined
  let purpose: string | undefined

  let rest = rawInput.trim()
  if (rest.length === 0) return { ok: false, error: `缺少主题。${USAGE}` }

  // --purpose "..."（双引号；空串视为未提供）
  rest = rest.replace(/--purpose\s+"([^"]*)"/g, (_match, value: string) => {
    if (value.length > 0) purpose = value
    return ' '
  })

  // --depth <1-3>
  const depthMatch = rest.match(/--depth\s+(\d+)/)
  if (depthMatch !== null) {
    const token = depthMatch[1] ?? ''
    const parsed = Number(token)
    if (!(parsed >= 1 && parsed <= 3)) {
      return { ok: false, error: `--depth 必须是 1、2 或 3（收到 "${token}"）。${USAGE}` }
    }
    depth = parsed
    rest = rest.replace(depthMatch[0], ' ')
  }

  // 布尔开关
  for (const [token, key] of BOOL_FLAGS) {
    if (rest.includes(token)) {
      flags[key] = true
      rest = rest.replaceAll(token, ' ')
    }
  }

  // 残留的 token 形态参数 = 无法识别
  const unknown = rest.match(/(?:^|\s)(--[^\s]+)/)
  if (unknown !== null) {
    return { ok: false, error: `无法识别的参数 "${unknown[1] ?? ''}"。${USAGE}` }
  }

  const topic = rest.trim().replace(/\s+/g, ' ')
  if (topic.length === 0) return { ok: false, error: `缺少主题。${USAGE}` }

  return {
    ok: true,
    request: {
      topic,
      ...(purpose !== undefined ? { purpose } : {}),
      depth: depth ?? 2,
      synthesize: !flags.noSynthesize,
      verify: !flags.noVerify,
      review: flags.review,
      foreground: flags.foreground,
    },
  }
}
