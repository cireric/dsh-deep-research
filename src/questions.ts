/**
 * dsh-deep-research v2 —— 调用方问题清单解析。
 *
 * 纯函数模块（零外部依赖）：从工具入参的 textarea 文本解析出问题条目，
 * 供"提供 questions 即跳过规划代理"路径直接使用。
 *
 * 编号剥离规则（宁可少剥、不可错剥——错剥会污染研究问题本身且无法恢复）：
 *   - 点号编号必须后跟至少一个空白才剥离，否则无法区分"1. 甲"与
 *     以小数开头的内容本身（"3.14 是什么"、"2.0版本……"）；
 *   - 顿号/右括号本身就是无歧义的列表标记，空白可省（"1、乙"、"3)丙"）。
 */

/** 解析每行一个的问题清单；剥离行首列表编号，丢弃空行。 */
export function parseQuestionList(raw: string | undefined): Array<{ question: string }> {
  if (typeof raw !== 'string') return []
  return raw
    .split('\n')
    .map((line) => line.replace(/^\s*(?:\d+\.\s+|\d+[、)])?/, '').trim())
    .filter((line) => line.length > 0)
    .map((question) => ({ question }))
}
