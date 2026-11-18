/**
 * 导入管线。
 *
 * 需求书 §6.3 的硬规矩：不许把解析、例句、答案提示当题干；无来源不入库；整批可回滚。
 * 这一版的实现方式是把「解析」和「入库」拆成两步：
 *   scan()   只解析、不落盘，把候选与警告原样交给用户看；
 *   commit() 用户勾选之后才写，写的时候逐条过 normalizeItem()，坏条目单条报错、不连坐。
 * 教材类文本默认落 status=candidate 或 needs_human，绝不直接进 active。
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { countChars, normalizeAnswer, nowIso, str } from './util.js'
import { itemFingerprint, normalizeItem } from './model.js'

const ANSWER_LINE = /^[\s*]*[（(【\[]?\s*答\s*案\s*[】)）\]]?\s*[:：]?\s*(.+)$/u
const EXPLAIN_LINE = /^[\s*]*[（(【\[]?\s*(解\s*析|答案解析|说明)\s*[】)）\]]?\s*[:：]?\s*(.*)$/u
const POINT_LINE = /^[\s*]*[（(【\[]?\s*(语法点|考点|知识点)\s*[】)）\]]?\s*[:：]?\s*(.*)$/u
const OPTION_LINE = /^\s*[（(]?\s*([A-Fa-fＡ-Ｆａ-ｆ])\s*[.．、:：)）]\s*(.+)$/u
const QUESTION_LINE = /^\s*(\d{1,3})\s*[.．、:：)）]\s*(.+)$/u
const REF_LINE = /^[\s*]*[（(【\[]?\s*(参考译文|译文|参考)\s*[】)）\]]?\s*[:：]?\s*(.+)$/u

function cleanLine(line) {
  return String(line).replace(/\r/gu, '').replace(/\*\*/gu, '').replace(/`/gu, '')
}

function splitSections(text) {
  const lines = text.split('\n').map(cleanLine)
  const blocks = []
  let current = { title: '', lines: [] }
  for (const line of lines) {
    if (/^#{1,4}\s+/u.test(line)) {
      if (current.lines.some((entry) => entry.trim())) blocks.push(current)
      current = { title: line.replace(/^#{1,4}\s+/u, '').trim(), lines: [] }
      continue
    }
    current.lines.push(line)
  }
  if (current.lines.some((entry) => entry.trim())) blocks.push(current)
  return blocks
}

/**
 * 解析选择题（词汇 / 语法）。
 * 支持的写法见 README「导入格式」；容忍 `**1.**`、`（答案）B`、全角字母等。
 */
export function parseMarkdownQuestions(text, type) {
  const warnings = []
  const questions = []
  const lines = String(text ?? '').split('\n').map(cleanLine)
  let current = null
  let mode = 'stem'

  const flush = () => {
    if (!current) return
    if (!current.stem) {
      warnings.push(`第 ${current.index ?? '?'} 题没有题干，已跳过。`)
      current = null
      return
    }
    if (!current.options || current.options.length < 2) {
      warnings.push(`第 ${current.index ?? '?'} 题选项不足，已跳过：「${current.stem.slice(0, 24)}」`)
      current = null
      return
    }
    const answer = normalizeAnswer(current.answer, current.options.length)
    const index = current.options.findIndex((option, optionIndex) => String.fromCharCode(65 + optionIndex) === answer)
    questions.push({
      stem: current.stem,
      options: current.options,
      answer,
      answer_src: answer ? 'official' : 'none',
      explanation: current.explanation ?? '',
      point: type === 'grammar' ? current.point ?? '' : '',
      // 解析里常混着「答案：B」这类提示，单独存，不拼进题干。
      warnings: index < 0 && answer ? ['答案字母超出选项范围'] : [],
    })
    current = null
  }

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) {
      if (current) mode = 'stem'
      continue
    }
    const questionMatch = QUESTION_LINE.exec(line)
    if (questionMatch) {
      flush()
      current = { index: Number(questionMatch[1]), stem: questionMatch[2].trim(), options: [], answer: '', explanation: '', point: '' }
      mode = 'stem'
      continue
    }
    if (!current) continue
    const answerMatch = ANSWER_LINE.exec(line)
    if (answerMatch) {
      current.answer = answerMatch[1].trim()
      mode = 'answer'
      continue
    }
    const explainMatch = EXPLAIN_LINE.exec(line)
    if (explainMatch) {
      current.explanation = explainMatch[2].trim()
      mode = 'explanation'
      continue
    }
    const pointMatch = POINT_LINE.exec(line)
    if (pointMatch) {
      current.point = pointMatch[2].trim()
      mode = 'point'
      continue
    }
    const optionMatch = OPTION_LINE.exec(line)
    if (optionMatch) {
      const letter = optionMatch[1].toUpperCase().normalize('NFKC')
      const expected = String.fromCharCode(65 + current.options.length)
      if (letter !== expected) {
        warnings.push(`第 ${current.index ?? '?'} 题选项顺序异常（期望 ${expected}，实际 ${letter}），按出现顺序收下。`)
      }
      current.options.push(optionMatch[2].trim())
      mode = 'option'
      continue
    }
    if (mode === 'stem') current.stem += line
    else if (mode === 'explanation') current.explanation += '\n' + line
    else if (mode === 'point') current.point += line
    else if (mode === 'option' && current.options.length > 0) current.options[current.options.length - 1] += line
  }
  flush()
  return { questions, warnings }
}

/**
 * 解析阅读：每篇用 `---` 或 `【文章】` 分隔。
 * 先【文章】整段，再若干小题（结构同选择题）。
 */
export function parseMarkdownReading(text) {
  const warnings = []
  const passages = []
  const rawBlocks = String(text ?? '')
    .split(/\n\s*---\s*\n/u)
    .map((block) => block.trim())
    .filter(Boolean)

  for (const block of rawBlocks) {
    const lines = block.split('\n').map(cleanLine)
    const passageLines = []
    const questionLines = []
    let inQuestions = false
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      if (/^(【\s*题\s*目\s*】|#+\s*题目|\d{1,3}\s*[.．]\s*)/u.test(trimmed)) inQuestions = true
      if (/(【\s*文\s*章\s*】|【\s*原\s*文\s*】)/u.test(trimmed)) {
        const rest = trimmed.replace(/^.*?(【\s*文\s*章\s*】|【\s*原\s*文\s*】)\s*/u, '').trim()
        if (rest) passageLines.push(rest)
        inQuestions = false
        continue
      }
      if (inQuestions) questionLines.push(line)
      else passageLines.push(line)
    }
    const passage = passageLines.join('\n').replace(/【\s*题\s*目\s*】/gu, '').trim()
    if (!passage) {
      warnings.push('有一篇没有识别出文章正文，已跳过。')
      continue
    }
    if (questionLines.length === 0) {
      warnings.push(`「${passage.slice(0, 20)}…」这篇没有小题，已跳过（阅读必须带小题才能判分）。`)
      continue
    }
    const parsed = parseMarkdownQuestions(questionLines.join('\n'), 'reading')
    warnings.push(...parsed.warnings.map((warning) => `阅读：${warning}`))
    if (parsed.questions.length === 0) continue
    passages.push({
      passage,
      chars: countChars(passage),
      questions: parsed.questions.map((question) => ({
        stem: question.stem,
        options: question.options,
        answer: question.answer,
        explanation: question.explanation,
      })),
    })
  }
  return { passages, warnings }
}

/** 解析翻译段：整篇一块，或用 `---` / `### n` 分隔；`参考译文：` 另起一行。 */
export function parseMarkdownPassages(text, type) {
  const warnings = []
  const blocks = String(text ?? '')
    .split(/\n\s*---\s*\n/u)
    .map((block) => block.trim())
    .filter(Boolean)
  const items = []
  for (const block of blocks) {
    const lines = block.split('\n').map(cleanLine)
    const body = []
    let ref = ''
    let title = ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      if (/^(###?\s*|题|段)/u.test(trimmed) && trimmed.length <= 24 && !ref) {
        title = trimmed.replace(/^#+\s*/u, '').trim()
        continue
      }
      const refMatch = REF_LINE.exec(trimmed)
      if (refMatch) {
        ref = refMatch[2].trim()
        continue
      }
      if (ref) ref += '\n' + trimmed
      else body.push(trimmed)
    }
    const content = body.join('\n').trim()
    if (!content) continue
    if (countChars(content) < 20) {
      warnings.push(`「${content.slice(0, 20)}」太短（不足 20 字），已跳过。`)
      continue
    }
    items.push({
      text: content,
      ref: ref.trim(),
      ref_src: ref.trim() ? 'official' : 'none',
      title,
      chars: countChars(content),
      rubric: [],
    })
  }
  return { items, warnings }
}

function jsonItems(text) {
  const parsed = JSON.parse(text)
  if (Array.isArray(parsed)) return parsed
  if (parsed && Array.isArray(parsed.items)) return parsed.items
  if (parsed && typeof parsed === 'object') return [parsed]
  throw new Error('JSON 顶层应为数组，或 { items: [...] }')
}

/**
 * 解析一段文本为候选条目（不落盘）。
 * @param {{type: string, format: 'auto'|'json'|'markdown', text: string, source: string, batch: string}} input
 */
export function scanText({ type, format = 'auto', text, source, batch }) {
  const body = String(text ?? '').trim()
  if (!body) throw new Error('没有内容可解析')
  const warnings = []
  const rawItems = []
  const isJson = format === 'json' || (format === 'auto' && /^[[{]/u.test(body))

  if (isJson) {
    let parsed
    try {
      parsed = jsonItems(body)
    } catch (error) {
      throw new Error(`JSON 解析失败：${error.message}`)
    }
    if (type === 'reading') {
      for (const entry of parsed) rawItems.push(entry)
    } else if (type === 'ja2zh' || type === 'zh2ja') {
      for (const entry of parsed) {
        rawItems.push(typeof entry === 'string' ? { text: entry } : entry)
      }
    } else {
      for (const entry of parsed) rawItems.push(entry)
    }
  } else if (type === 'reading') {
    const parsed = parseMarkdownReading(body)
    warnings.push(...parsed.warnings)
    for (const passage of parsed.passages) rawItems.push(passage)
  } else if (type === 'ja2zh' || type === 'zh2ja') {
    const parsed = parseMarkdownPassages(body, type)
    warnings.push(...parsed.warnings)
    for (const item of parsed.items) rawItems.push(item)
  } else {
    const parsed = parseMarkdownQuestions(body, type)
    warnings.push(...parsed.warnings)
    for (const question of parsed.questions) rawItems.push(question)
  }

  const candidates = []
  for (let index = 0; index < rawItems.length; index += 1) {
    const raw = rawItems[index]
    try {
      const item = normalizeItem(type, { status: 'candidate', ...raw, source: str(raw.source, source || '导入') }, { batch })
      item.status = item.answer || (item.questions ?? []).every((question) => question.answer) || item.ref
        ? 'candidate'
        : 'needs_human'
      item.hash = itemFingerprint(item)
      candidates.push({
        index,
        item,
        ok: true,
        warnings: raw.warnings ?? [],
        preview: item.stem ? `${item.stem.slice(0, 80)}` : (item.text ?? item.passage ?? '').slice(0, 80),
      })
    } catch (error) {
      candidates.push({ index, ok: false, error: String(error?.message ?? error), raw })
    }
  }

  const okCount = candidates.filter((entry) => entry.ok).length
  return {
    type,
    source: source || '导入',
    batch,
    total: candidates.length,
    ok: okCount,
    failed: candidates.length - okCount,
    warnings,
    candidates,
    needs_human: candidates.filter((entry) => entry.ok && entry.item.status === 'needs_human').length,
  }
}

/**
 * 从 translation-drill 的教材语料库导入（需求书 §13）。
 *
 * S = 小段（单句/一小段），只当练习素材，**不进实务组卷**；
 * L = 整篇，由若干 S 段组成，这里把子段按顺序拼回整篇（保留段边界），才可以进实务卷。
 */
export async function readCorpus(file) {
  const text = await fs.readFile(file, 'utf8')
  const parsed = JSON.parse(text)
  if (!Array.isArray(parsed)) throw new Error('语料文件应为数组')
  return parsed
}

// 语料正文里混着「本文选自：…」「（出处：NHK，2025…）」这类注记，考试时不该出现在原文里。
const METADATA_LINE = /^\s*[（(【[]?\s*(本文选自|本文标题|本文作者|本文翻译|全文字数|原文出处|出处|出處|选编自|選自|选自|来源)\s*[】)）\]]?\s*[：:]/u
const TRAILING_SOURCE = /[（(]\s*(出处|出處|来源|選自|选自)\s*[：:][^）)]{0,120}[）)]\s*$/u
// 句中的出处注记（教材原文里同一段可能跟 2～3 条）
const INLINE_SOURCE = /[（(]\s*(出处|出處|来源|選自|选自)\s*[：:][^）)]{0,160}[）)]/gu
// 整理者自己写的说明行（※ 开头、或提到「参考译文只是为了…」）
const EDITOR_NOTE = /(^|\n)\s*(※|参考译文只是为了)[^\n]*/gu

export function cleanCorpusText(raw) {
  const lines = String(raw ?? '').replace(/\r/gu, '').split('\n')
  let dropped = 0
  while (lines.length > 0 && dropped < 5) {
    const head = lines[0].trim()
    if (!head) {
      lines.shift()
      continue
    }
    if (METADATA_LINE.test(lines[0])) {
      lines.shift()
      dropped += 1
      continue
    }
    break
  }
  return lines
    .join('\n')
    .replace(EDITOR_NOTE, '')
    .replace(INLINE_SOURCE, '')
    .replace(TRAILING_SOURCE, '')
    .replace(/[ \t]+\n/gu, '\n')
    .trim()
}

export function corpusToCandidates(list, { kind = 'S', batch, limit = 2000 } = {}) {
  const byId = new Map()
  for (const entry of list) if (entry && entry.id) byId.set(entry.id, entry)

  const candidates = []
  let skipped = 0
  let truncated = 0

  const push = (entry, { text, ref, title, fullText }) => {
    if (candidates.length >= limit) {
      truncated += 1
      return
    }
    const type = entry.dir === '中→日' ? 'zh2ja' : 'ja2zh'
    const content = cleanCorpusText(text)
    if (!content) {
      skipped += 1
      return
    }
    const item = normalizeItem(
      type,
      {
        text: content,
        ref: str(ref).trim(),
        ref_src: str(ref).trim() ? 'official' : 'none',
        title: title ?? '',
        source: `translation-drill/${entry.cls ?? '教材'} · ${entry.id}`,
        difficulty: 'L2',
        status: 'candidate',
        ai_extracted: false,
        full_text: fullText,
        tags: [str(entry.cls), entry.kind, fullText ? '整篇' : '小段'].filter(Boolean),
      },
      { batch },
    )
    item.hash = itemFingerprint(item)
    candidates.push({
      index: candidates.length,
      ok: true,
      item,
      warnings: [],
      preview: `${entry.id} ${fullText ? '[整篇]' : '[小段]'} ${content.slice(0, 40)}`,
    })
  }

  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue
    if (kind !== 'all' && entry.kind !== kind) continue
    if (entry.kind === 'L') {
      const children = Array.isArray(entry.children)
        ? entry.children.map((id) => byId.get(id)).filter(Boolean)
        : []
      if (children.length === 0) {
        skipped += 1
        continue
      }
      push(entry, {
        text: children.map((child) => str(child.text).trim()).filter(Boolean).join('\n\n'),
        ref: children.map((child) => str(child.ref).trim()).filter(Boolean).join('\n\n'),
        title: str(entry.title).trim(),
        fullText: true,
      })
      continue
    }
    push(entry, { text: entry.text, ref: entry.ref, title: str(entry.title).trim(), fullText: false })
  }

  return { candidates, skipped, truncated }
}

export function sourceLabelForFile(file) {
  return `文件：${path.basename(file)}`
}

export function makeBatchId(prefix = 'B') {
  const stamp = nowIso().replace(/[-:T.]/gu, '').slice(0, 14)
  return `${prefix}-${stamp}`
}
