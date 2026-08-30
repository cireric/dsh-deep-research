/**
 * Pure parser for the `/deep-research` command line. Leaf module: no
 * dependencies, no I/O — unit-testable without a host (tests/command.spec.mjs).
 *
 * Grammar (everything after the command name, verbatim from the composer):
 *   <topic> [--depth 1-3] [--purpose "…"] [--clarify auto|minimal|never]
 *
 * Flags may appear anywhere; the remaining text (whitespace-collapsed) is the
 * topic. `--depth` / `--purpose` / `--clarify` are advisory hints (ADR-0003):
 * they are rendered into the follow-up message, not enforced beyond syntactic
 * validity. Defaults (depth 2, clarifyStrategy from plugin config) live in the
 * tool face / plugin config, not the command grammar.
 *
 * `buildResearchIntentMessage` is the single source of truth for the
 * clarification-policy prompt injected with every `/deep-research` intent —
 * behavior lives here (not in docs), so it is testable and cannot drift from
 * the shipped code.
 *
 * @module dsh-deep-research/command
 */

/** Clarification policy: how the intent-entry message instructs the main agent. */
export type ClarifyStrategy = 'auto' | 'minimal' | 'never'

export const CLARIFY_STRATEGIES: readonly ClarifyStrategy[] = ['auto', 'minimal', 'never']

/** 入口澄清策略的默认值（单一事实来源；index.ts 的 DEFAULTS 引用同一常量）。 */
export const DEFAULT_CLARIFY_STRATEGY: ClarifyStrategy = 'minimal'

/** One parsed user request, ready for the intent-entry follow-up message. */
export interface ResearchCommandRequest {
  /** Whitespace-collapsed remaining text; non-empty on ok. */
  readonly topic: string
  /** Present exactly when a non-empty `--purpose "…"` was supplied. */
  readonly purpose?: string
  /** Present exactly when `--depth 1-3` was supplied. */
  readonly depth?: number
  /** Present exactly when `--clarify auto|minimal|never` was supplied. */
  readonly clarify?: ClarifyStrategy
}

export type ParseResearchResult =
  | { ok: true; request: ResearchCommandRequest }
  | { ok: false; error: string }

const USAGE =
  '用法：/deep-research <主题> [--depth 1-3] [--purpose "…"] [--clarify auto|minimal|never]'

/**
 * Parse one command line into a research request.
 * @param rawInput - verbatim text after the command name (may be empty).
 * @returns the request, or a human-readable error (usage included).
 */
export function parseResearchCommand(rawInput: string): ParseResearchResult {
  let depth: number | undefined
  let purpose: string | undefined
  let clarify: ClarifyStrategy | undefined

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

  // --clarify auto|minimal|never
  const clarifyMatch = rest.match(/--clarify\s+([A-Za-z]+)/)
  if (clarifyMatch !== null) {
    const token = clarifyMatch[1] ?? ''
    if (!CLARIFY_STRATEGIES.includes(token as ClarifyStrategy)) {
      return {
        ok: false,
        error: `--clarify 必须是 auto、minimal 或 never（收到 "${token}"）。${USAGE}`,
      }
    }
    clarify = token as ClarifyStrategy
    rest = rest.replace(clarifyMatch[0], ' ')
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
      ...(depth !== undefined ? { depth } : {}),
      ...(clarify !== undefined ? { clarify } : {}),
    },
  }
}

/**
 * Build the intent-entry message injected for `/deep-research` (ADR-0003).
 * Advisable hints (`purpose` / `depth`) are NOT embedded here — the caller
 * appends them as separate lines so the policy text stays stable and testable.
 *
 * @param request - parsed request (topic always present).
 * @param clarify - policy to render; defaults to DEFAULT_CLARIFY_STRATEGY ('minimal')
 *   (cost-function rule: ask only when missing info forks the answer space,
 *   default everything else).
 */
export function buildResearchIntentMessage(
  request: ResearchCommandRequest,
  clarify: ClarifyStrategy = DEFAULT_CLARIFY_STRATEGY,
): string {
  const { topic } = request
  switch (clarify) {
    case 'auto':
      return `对「${topic}」做一次深度研究。若研究目的或范围还不够明确，先向用户澄清 1–2 个关键问题；否则直接调用 deep_research 工具开始研究。`
    case 'never':
      return (
        `对「${topic}」做一次深度研究。` +
        '\n' +
        '澄清规则（never）：禁止向用户提出任何澄清问题。若主题缺失你认为关键的决策信息（如对比基线、成功标准），' +
        '不要询问用户——将其作为研究假设追加进 purpose 参数并单列标注（前缀"假设："）；若未提供研究用途则新建，' +
        '研究过程中显式验证该假设成立与否并标注，不得覆盖用户已提供的用途。' +
        '\n' +
        '随后直接调用 deep_research 工具开始研究。'
      )
    case 'minimal':
    default:
      return (
        `对「${topic}」做一次深度研究。` +
        '\n' +
        '澄清规则（minimal）：' +
        '\n' +
        '1. 仅当缺失信息存在 ≥2 个合理且会显著改变研究范围的解释（分叉）时，才允许向用户澄清——最多 1 轮、1 个单选问题，' +
        '必须提供"跳过，用默认"选项，选项文本不得带有倾向性标注；' +
        '\n' +
        '2. 可推断或单一合理默认的信息（语言、产出形式、场景权重、深度等）一律自行默认，禁止提问；' +
        '\n' +
        '3. 若已提供问题清单（questions 参数），直接调用 deep_research 工具开始研究，禁止再澄清；' +
        '\n' +
        '4. 其余情况直接调用 deep_research 工具开始研究。'
      )
  }
}
