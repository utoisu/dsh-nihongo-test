/**
 * 题库条目的规范化与派生视图。
 *
 * 这里是唯一的「一条题长什么样」的定义：导入、手工新增、Agent 工具写入都要过
 * normalizeItem()，所以坏数据进不来。字段命名对齐需求书 §5。
 */
import {
  DIFFICULTIES,
  ID_PREFIX,
  OBJECTIVE_TYPES,
  PRACTICE_TYPES,
  TYPES,
  countChars,
  hashOf,
  normalizeAnswer,
  nowIso,
  str,
  truncate,
} from './util.js'

const STATUSES = new Set(['candidate', 'active', 'disputed', 'rejected', 'needs_human'])
const EXAM_KINDS = new Set(['real', 'mock', 'textbook', ''])
const LEVELS = new Set(['2', '3', ''])

/** 二笔 / 三笔：同一本教材里可能两级的题混着，题库里要能分开筛。 */
function inferLevel(raw) {
  const value = String(raw.level ?? '').trim()
  if (value === '2' || value === '3') return value
  const haystack = `${(raw.tags ?? []).join(' ')} ${raw.source ?? ''}`
  if (/三笔|三级/u.test(haystack)) return '3'
  if (/二笔|二级/u.test(haystack)) return '2'
  return ''
}

/** 老条目没有 exam_kind/year 时（字段是后加的），按来源和标签补出来。 */
export function classifyItem(raw) {
  const exam_kind = inferExamKind(raw)
  let year = Number.isFinite(Number(raw.year)) && Number(raw.year) > 1990 ? Number(raw.year) : null
  if (year === null) {
    const fromSource = /^(\d{4})/u.exec(String(raw.source ?? ''))
    const fromTags = (raw.tags ?? []).map(String).find((tag) => /^\d{4}$/u.test(tag))
    const guess = fromSource ? Number(fromSource[1]) : fromTags ? Number(fromTags) : null
    year = Number.isFinite(guess) && guess > 1990 ? guess : null
  }
  return { exam_kind, year, level: inferLevel(raw) }
}

/** 真题 / 模拟 / 教材：题库里要能分开筛、组卷时能分开抽。 */
function inferExamKind(raw) {
  if (EXAM_KINDS.has(raw.exam_kind)) return raw.exam_kind
  const haystack = `${(raw.tags ?? []).join(' ')} ${raw.source ?? ''}`
  if (/模拟/u.test(haystack)) return 'mock'
  if (/真题|解析版/u.test(haystack)) return 'real'
  if (/教材|translation-drill|讲义/u.test(haystack)) return 'textbook'
  return ''
}

function fail(message) {
  const error = new Error(message)
  error.code = 'INVALID_ITEM'
  throw error
}

function normalizeOptions(raw) {
  let options = []
  if (Array.isArray(raw)) {
    options = raw.map((option) => {
      if (typeof option === 'string') return option.trim()
      if (option && typeof option === 'object') {
        return str(option.text ?? option.label ?? option.content ?? option.value).trim()
      }
      return ''
    })
  } else if (raw && typeof raw === 'object') {
    options = Object.keys(raw)
      .sort()
      .map((key) => str(raw[key]).trim())
  }
  options = options.filter((option) => option.length > 0)
  if (options.length < 2) fail('选项少于 2 个')
  if (options.length > 6) fail('选项多于 6 个')
  return options
}

function normalizeRubric(raw) {
  if (!Array.isArray(raw)) return []
  return raw
    .map((entry) => {
      if (typeof entry === 'string') return { point: entry.trim(), weight: 1 }
      if (!entry || typeof entry !== 'object') return null
      const point = str(entry.point ?? entry.点 ?? entry.text).trim()
      if (!point) return null
      const weight = Number(entry.weight ?? entry.权重 ?? 1)
      return { point, weight: Number.isFinite(weight) && weight > 0 ? weight : 1 }
    })
    .filter(Boolean)
}

function normalizeQuestions(raw) {
  if (!Array.isArray(raw) || raw.length === 0) fail('阅读理解缺少 questions')
  return raw.map((question, index) => {
    if (!question || typeof question !== 'object') fail(`第 ${index + 1} 小题不是对象`)
    const stem = str(question.stem ?? question.题干).trim()
    if (!stem) fail(`第 ${index + 1} 小题缺题干`)
    const options = normalizeOptions(question.options ?? question.选项)
    const answer = normalizeAnswer(question.answer ?? question.答案, options.length)
    return {
      stem,
      options,
      answer,
      answer_src: str(question.answer_src, answer ? 'official' : 'none'),
      explanation: str(question.explanation ?? question.解析).trim(),
    }
  })
}

/**
 * @param {string} type
 * @param {object} raw 用户/导入器给的原始对象
 * @param {{id?: string, batch?: string, source?: object}} context
 */
export function normalizeItem(type, raw, context = {}) {
  if (!TYPES.includes(type)) fail(`未知题型 ${type}`)
  if (!raw || typeof raw !== 'object') fail('条目不是对象')

  const item = {
    id: str(context.id ?? raw.id),
    type,
    source: str(raw.source ?? context.source?.label ?? '手工录入').trim(),
    difficulty: DIFFICULTIES.includes(raw.difficulty) ? raw.difficulty : 'L2',
    topic: str(raw.topic).trim(),
    tags: Array.isArray(raw.tags) ? raw.tags.map((tag) => str(tag).trim()).filter(Boolean) : [],
    status: STATUSES.has(raw.status) ? raw.status : 'candidate',
    ai_extracted: raw.ai_extracted === true,
    audit_batch: str(raw.audit_batch ?? context.batch ?? ''),
    exam_kind: inferExamKind(raw),
    level: inferLevel(raw),
    year: Number.isFinite(Number(raw.year)) && Number(raw.year) > 1990 ? Number(raw.year) : null,
    created_at: str(raw.created_at, nowIso()),
    updated_at: nowIso(),
    notes: str(raw.notes).trim(),
  }

  if (OBJECTIVE_TYPES.has(type) && type !== 'reading') {
    item.stem = str(raw.stem ?? raw.题干).trim()
    if (!item.stem) fail('缺题干')
    item.options = normalizeOptions(raw.options ?? raw.选项)
    item.answer = normalizeAnswer(raw.answer ?? raw.答案, item.options.length)
    item.explanation = str(raw.explanation ?? raw.解析).trim()
    if (type === 'grammar') item.point = str(raw.point ?? raw.语法点).trim()
    item.answer_src = str(raw.answer_src, item.answer ? 'official' : 'none')
    item.answer_status = str(raw.answer_status, item.answer ? 'confirmed' : 'provisional')
    item.confidence = ['high', 'mid', 'low'].includes(raw.confidence) ? raw.confidence : 'high'
    item.answer_reason = str(raw.answer_reason).trim()
    if (!item.answer) {
      if (item.status === 'active' || item.status === 'candidate') item.status = 'needs_human'
      item.answer_status = 'provisional'
      if (!item.answer_reason) item.answer_reason = '导入时没有答案，等待补全'
    }
    item.chars = countChars(item.stem)
  } else if (type === 'reading') {
    item.passage = str(raw.passage ?? raw.文章).trim()
    if (!item.passage) fail('缺 passage')
    item.questions = normalizeQuestions(raw.questions ?? raw.小题)
    item.title = str(raw.title ?? raw.标题).trim()
    item.chars = countChars(item.passage)
    item.answer_src = item.questions.every((q) => q.answer) ? 'official' : 'none'
    item.answer_status = item.answer_src === 'official' ? 'confirmed' : 'provisional'
    item.confidence = 'high'
    if (item.answer_src !== 'official' && item.status === 'active') item.status = 'needs_human'
  } else if (PRACTICE_TYPES.has(type)) {
    item.text = str(raw.text ?? raw.原文).trim()
    if (!item.text) fail('缺原文 text')
    item.title = str(raw.title ?? raw.标题).trim()
    item.ref = str(raw.ref ?? raw.参考译文).trim()
    item.ref_src = ['official', 'ai_solved', 'none'].includes(raw.ref_src)
      ? raw.ref_src
      : item.ref
        ? 'official'
        : 'none'
    item.rubric = normalizeRubric(raw.rubric)
    item.chars = countChars(item.text)
    // 整篇才能进实务卷；S 小段（教材里的单句/小段落）不进组卷。
    item.full_text = raw.full_text !== false && raw.kind !== 'S'
    if (!item.ref) item.ref_src = 'none'
  }

  item.hash = str(raw.hash) || itemFingerprint(item)
  return item
}

/** 去重指纹：只取「题目本体」，不含 id / 来源 / 状态。 */
export function itemFingerprint(item) {
  const core = { type: item.type }
  if (item.type === 'reading') {
    core.passage = collapse(item.passage)
    core.questions = (item.questions ?? []).map((q) => [collapse(q.stem), q.options])
  } else if (PRACTICE_TYPES.has(item.type)) {
    core.text = collapse(item.text)
  } else {
    core.stem = collapse(item.stem)
    core.options = item.options
  }
  return hashOf(JSON.stringify(core))
}

function collapse(text) {
  return String(text ?? '').replace(/\s+/gu, '')
}

/**
 * 宽松指纹：全半角、空白、标点、符号全部抹平后取 hash。
 * 不同材料收录同一道题时，OCR 常把标点、全半角、空格弄得不一致，严格 hash 抓不住；
 * 这一层是「同一篇文字换了排版」的兜底。语义相同但改写过的内容仍然抓不住。
 */
export function looseFingerprint(item) {
  let raw = ''
  if (item.type === 'reading') {
    raw = `${item.passage ?? ''} ${(item.questions ?? []).map((question) => question.stem ?? '').join(' ')}`
  } else if (PRACTICE_TYPES.has(item.type)) {
    raw = item.text ?? ''
  } else {
    raw = `${item.stem ?? ''} ${(item.options ?? []).join(' ')}`
  }
  const normalized = String(raw)
    .normalize('NFKC')
    .replace(/[\s\p{P}\p{S}]/gu, '')
  return hashOf(normalized)
}

export function nextItemId(type, existingIds) {
  const prefix = ID_PREFIX[type]
  let max = 0
  for (const id of existingIds) {
    const match = new RegExp(`^${prefix}-(\\d+)$`, 'u').exec(id)
    if (match) max = Math.max(max, Number(match[1]))
  }
  return `${prefix}-${String(max + 1).padStart(4, '0')}`
}

/** 列表里用的摘要：不把整篇原文塞进列表接口。 */
export function summarizeItem(item) {
  const base = {
    id: item.id,
    type: item.type,
    status: item.status,
    source: item.source,
    difficulty: item.difficulty,
    topic: item.topic,
    tags: item.tags,
    chars: item.chars,
    audit_batch: item.audit_batch,
    ai_extracted: item.ai_extracted,
    exam_kind: item.exam_kind ?? '',
    level: item.level ?? '',
    year: item.year ?? null,
    updated_at: item.updated_at,
  }
  if (item.type === 'reading') {
    return {
      ...base,
      preview: truncate(item.title || item.passage, 90),
      questions: item.questions?.length ?? 0,
      hasAnswer: item.answer_src === 'official' && (item.questions ?? []).every((q) => q.answer),
    }
  }
  if (PRACTICE_TYPES.has(item.type)) {
    return {
      ...base,
      preview: truncate(item.text, 90),
      hasAnswer: Boolean(item.ref),
      ref_src: item.ref_src,
      rubric: item.rubric?.length ?? 0,
      full_text: item.full_text !== false,
    }
  }
  return {
    ...base,
    preview: truncate(item.stem, 90),
    hasAnswer: Boolean(item.answer),
    answer_src: item.answer_src ?? 'none',
    answer_status: item.answer_status ?? '',
    confidence: item.confidence ?? 'high',
  }
}

/**
 * 考试中场次用的脱敏视图：擦掉答案与参考译文。
 * 试卷文件本身含答案（判卷要用），但考试接口不能把它发到浏览器。
 */
export function redactItem(item) {
  const copy = { ...item }
  delete copy.hash
  if (item.type === 'reading') {
    copy.questions = (item.questions ?? []).map((question) => {
      const q = { ...question }
      delete q.answer
      delete q.answer_src
      delete q.explanation
      return q
    })
    delete copy.answer_src
  } else if (PRACTICE_TYPES.has(item.type)) {
    delete copy.ref
    delete copy.ref_src
    delete copy.rubric
  } else {
    delete copy.answer
    delete copy.explanation
    delete copy.answer_reason
    delete copy.answer_src
    delete copy.confidence
  }
  delete copy.notes
  return copy
}

export function isObjective(item) {
  return OBJECTIVE_TYPES.has(item.type)
}



