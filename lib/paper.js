/**
 * 组卷：模板配额、自由配额、约束校验、抽题、快照。
 *
 * 两条硬规矩（需求书 §8、§9）：
 *  1) 试卷存**完整快照**，不存题目 id。日后改库，旧成绩仍然对得上。
 *  2) 抽不满就明说缺多少、为什么缺，绝不拿别的题凑数。
 */
import { OBJECTIVE_TYPES, PRACTICE_TYPES, TYPES, countChars, nowIso } from './util.js'
import { itemFingerprint } from './model.js'

export const BLUEPRINTS = {
  comprehensive: {
    id: 'catti2-comprehensive',
    title: 'CATTI 二级 · 综合',
    mode: 'template',
    duration_min: 120,
    sections: [
      // CATTI 二级综合：75 题 / 100 分，不是均分。
      { type: 'vocab', count: 10, points: 10, label: '词汇选择' },
      { type: 'grammar', count: 40, points: 40, label: '语法' },
      { type: 'reading', count: 25, points: 50, label: '阅读理解', unit: 'questions' },
    ],
  },
  practice: {
    id: 'catti2-practice',
    title: 'CATTI 二级 · 实务',
    mode: 'template',
    duration_min: 180,
    sections: [
      { type: 'ja2zh', count: 3, points: 50, label: '日译中', chars: [1500, 1700] },
      { type: 'zh2ja', count: 3, points: 50, label: '中译日', chars: [750, 850] },
    ],
  },
  full: {
    id: 'catti2-full',
    title: 'CATTI 二级 · 全卷（综合 + 实务）',
    mode: 'template',
    duration_min: 300,
    sections: [
      { type: 'vocab', count: 10, points: 10, label: '词汇选择' },
      { type: 'grammar', count: 40, points: 40, label: '语法' },
      { type: 'reading', count: 25, points: 50, label: '阅读理解', unit: 'questions' },
      { type: 'ja2zh', count: 3, points: 50, label: '日译中', chars: [1500, 1700] },
      { type: 'zh2ja', count: 3, points: 50, label: '中译日', chars: [750, 850] },
    ],
  },
}

export function blueprintById(id) {
  return Object.values(BLUEPRINTS).find((blueprint) => blueprint.id === id) ?? null
}

function shuffle(list, rng = Math.random) {
  const copy = [...list]
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(rng() * (index + 1))
    ;[copy[index], copy[swap]] = [copy[swap], copy[index]]
  }
  return copy
}

/** 预览与正式建卷用同一个 seed，保证「看到的」就是「考到的」。 */
export function makeRng(seed) {
  let state = (Number(seed) || 1) >>> 0
  return function rng() {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function matchesConstraints(item, constraints) {
  if (!constraints) return true
  if (Array.isArray(constraints.difficulty) && constraints.difficulty.length > 0) {
    if (!constraints.difficulty.includes(item.difficulty)) return false
  }
  if (Array.isArray(constraints.topic) && constraints.topic.length > 0) {
    if (!constraints.topic.includes(item.topic)) return false
  }
  if (constraints.source) {
    const source = String(item.source ?? '')
    const kind = item.exam_kind ?? ''
    // 来源只有三类：真题 / 模拟 / 教材；人工录入另外算。有 exam_kind 就以它为准。
    if (constraints.source === 'real') {
      if (kind ? kind !== 'real' : !/真题|CATTI|二笔/u.test(source)) return false
    }
    if (constraints.source === 'mock') {
      if (kind ? kind !== 'mock' : !/模拟/u.test(source)) return false
    }
    if (constraints.source === 'textbook') {
      if (kind ? kind !== 'textbook' : !/translation-drill|教材|讲义|课堂/u.test(source)) return false
    }
    if (constraints.source === 'manual' && source !== '手工录入') return false
  }
  return true
}

function usableObjective(item) {
  if (item.status !== 'active') return false
  if (item.type === 'reading') {
    return Boolean(item.passage) && (item.questions ?? []).length > 0 && (item.questions ?? []).every((q) => q.answer)
  }
  return Boolean(item.stem) && Array.isArray(item.options) && item.options.length >= 2 && Boolean(item.answer)
}

function usablePractice(item) {
  if (item.status !== 'active') return false
  if (item.full_text === false) return false
  return Boolean(item.text)
}

function questionsOf(item) {
  return item.type === 'reading' ? (item.questions ?? []).length : 1
}

/** 组卷可用性：模板面板上的「可抽」和真正抽题必须用同一把尺子。 */
export function usableForPaper(item) {
  return PRACTICE_TYPES.has(item.type) ? usablePractice(item) : usableObjective(item)
}

/**
 * 按配额抽题。
 * @returns {{ok: boolean, sections: Array, shortfalls: Array, warnings: string[]}}
 */
export function composeSections(banks, blueprint, options = {}) {
  const excluded = new Set(options.excludedIds ?? [])
  const onlyIds = options.onlyIds instanceof Set ? options.onlyIds : options.onlyIds ? new Set(options.onlyIds) : null
  const rng = options.rng ?? Math.random
  const sections = []
  const shortfalls = []
  const warnings = []
  const picked = new Set()

  for (const quota of blueprint.sections ?? []) {
    const type = quota.type
    if (!TYPES.includes(type)) {
      shortfalls.push({ type, need: quota.count, have: 0, reason: `未知题型 ${type}` })
      continue
    }
    const pool = (banks[type] ?? []).filter((item) => {
      if (excluded.has(item.id) || picked.has(item.id)) return false
      if (onlyIds && !onlyIds.has(item.id)) return false
      if (PRACTICE_TYPES.has(type)) return usablePractice(item) && matchesConstraints(item, quota.constraints ?? options.constraints)
      return usableObjective(item) && matchesConstraints(item, quota.constraints ?? options.constraints)
    })

    const need = Math.max(0, Number(quota.count) || 0)
    let chosen = []
    if (PRACTICE_TYPES.has(type)) {
      // 实务只收整篇：S 小段不进卷（把两篇不相干的短文拼成一段，那段材料在考试里根本不成立）。
      chosen = quota.allow_pack
        ? packSegments(pool, need, quota.chars, rng)
        : pickPractice(pool, need, quota.chars, rng)
    } else if (type === 'reading') {
      chosen = pickReading(pool, need, rng)
    } else {
      chosen = shuffle(pool, rng).slice(0, need)
    }

    const got = type === 'reading'
      ? chosen.reduce((sum, item) => sum + questionsOf(item), 0)
      : chosen.length

    if (chosen.length < (type === 'reading' ? 1 : need) || (type !== 'reading' && got < need) || (type === 'reading' && got < need)) {
      const reason = pool.length === 0
        ? (PRACTICE_TYPES.has(type)
          ? '没有整篇可用（S 小段不进实务卷；需在库、active、整篇）'
          : '没有可用题目（需在库 active、有答案、未被近期试卷占用）')
        : `可用 ${type === 'reading' ? `${pool.length} 篇 / ${pool.reduce((sum, item) => sum + questionsOf(item), 0)} 题` : `${pool.length} 条`}，不足 ${need}`
      shortfalls.push({ type, need, have: got, reason })
    }

    for (const item of chosen) picked.add(item.id)

    const chars = chosen.reduce((sum, item) => sum + (Number(item.chars) || countChars(item.text ?? item.passage ?? '')), 0)
    if (quota.chars && chosen.length >= need) {
      const [min, max] = quota.chars
      if (chars < min || chars > max) {
        warnings.push(
          `${quota.label ?? type} 段级字数合计 ${chars}，不在模板建议的 ${min}–${max} 之间：`
          + '题库里只有整篇，拆段被禁止，所以长度只能这样；要贴预算就得换成更短的整篇。',
        )
      }
    }

    sections.push({
      type,
      label: quota.label ?? type,
      points: Number(quota.points) || 0,
      quota_count: need,
      questions: type === 'reading'
        ? chosen.reduce((sum, item) => sum + questionsOf(item), 0)
        : chosen.length,
      chars,
      items: chosen.map((item) => JSON.parse(JSON.stringify(item))),
    })
  }

  return {
    ok: shortfalls.length === 0,
    sections,
    shortfalls,
    warnings,
  }
}

/**
 * 实务段的选择：只挑整篇。
 *
 * 拼段被拿掉了——把「震灾」和「推特故障」拼成一段，那段材料在考试里根本不成立。
 * 确实要拼时走 quota.allow_pack，由 packSegments 严格限定同来源 + 同题材，并保留段边界。
 */
function pickPractice(pool, need, budget, rng) {
  if (need <= 0) return []
  if (!budget) return shuffle(pool, rng).slice(0, need)
  return pickSingles(pool, need, budget, rng)
}

/** 单条选择：按合计字数落进预算。 */
function pickSingles(pool, need, budget, rng) {
  const [min, max] = budget
  const target = Math.round(((min + max) / 2) / Math.max(need, 1))
  const ordered = [...pool].sort(
    (a, b) => Math.abs((a.chars ?? 0) - target) - Math.abs((b.chars ?? 0) - target) || rng() - 0.5,
  )
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const offset = attempt === 0 ? 0 : Math.floor(rng() * Math.max(1, ordered.length - need))
    const slice = ordered.slice(offset, offset + need)
    if (slice.length < need) continue
    const total = slice.reduce((sum, item) => sum + (Number(item.chars) || 0), 0)
    if (total >= min && total <= max) return slice
  }
  return ordered.slice(0, need)
}

/**
 * 拼段（只在 quota.allow_pack 时走这里）。
 * 硬约束：同一来源 + 同一题材才许拼；段与段之间用空行保留边界，绝不合并成一段。
 */
function packSegments(pool, need, budget, rng) {
  if (need <= 0) return []
  const [min, max] = budget ?? [0, 0]
  const targetPer = budget ? ((min + max) / 2) / need : 0
  const groups = new Map()
  for (const item of pool) {
    const key = `${String(item.source ?? '').trim()}|${String(item.topic ?? '').trim()}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(item)
  }
  // 只有「同源同题材、且至少 2 条」的组才允许拼。
  const eligible = shuffle([...groups.values()].filter((group) => group.length >= 2), rng)
  const out = []
  for (const group of eligible) {
    if (out.length >= need) break
    const parts = []
    let chars = 0
    for (const item of shuffle(group, rng)) {
      parts.push(item)
      chars += Number(item.chars) || 0
      if (parts.length >= 2 && (!budget || chars >= targetPer * 0.9)) break
      if (parts.length >= 6) break
    }
    if (parts.length >= 2) out.push(composeSegment(parts))
  }
  return out.slice(0, need)
}

function composeSegment(parts) {
  const first = parts[0]
  const withRef = parts.filter((part) => part.ref)
  return {
    id: `SEG-${itemFingerprint({ ...first, text: parts.map((part) => part.text).join('\n\n') }).slice(0, 10).toUpperCase()}`,
    type: first.type,
    title: `拼段 · ${parts.length} 段（同源同题材）`,
    // 保留段边界：空行分界，不合并。
    text: parts.map((part) => part.text).join('\n\n'),
    ref: withRef.map((part) => part.ref).join('\n\n'),
    ref_src: withRef.length === parts.length ? 'official' : withRef.length > 0 ? 'official' : 'none',
    rubric: [],
    chars: parts.reduce((sum, part) => sum + (Number(part.chars) || 0), 0),
    composed_of: parts.map((part) => part.id),
    segment_count: parts.length,
    full_text: true,
    source: first.source,
    difficulty: first.difficulty ?? 'L2',
    topic: first.topic ?? '',
    tags: [],
    status: 'active',
    ai_extracted: false,
  }
}

/** 阅读按「篇」抽，凑够题数；宁可多一篇，不拆篇。 */
function pickReading(pool, needQuestions, rng) {
  const shuffled = shuffle(pool, rng)
  const chosen = []
  let total = 0
  let overshoot = null
  for (const passage of shuffled) {
    if (total >= needQuestions) break
    const count = questionsOf(passage)
    if (count <= 0) continue
    if (total + count <= needQuestions) {
      chosen.push(passage)
      total += count
      continue
    }
    // 这一篇会超：先记下超得最少的那篇，继续找能正好凑满的；
    // 实在凑不满就用它（阅读本来就不可能正好 25 题，允许小幅超出）
    if (!overshoot || count < questionsOf(overshoot)) overshoot = passage
  }
  if (total < needQuestions && overshoot) {
    chosen.push(overshoot)
    total += questionsOf(overshoot)
  }
  return chosen
}

function randomSuffix() {
  return Math.random().toString(36).slice(2, 6).toUpperCase()
}

export function newPaperId(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return `P-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}-${randomSuffix()}`
}

export function buildPaper({ blueprint, composed, title, durationMin }) {
  const sections = composed.sections
    .filter((section) => section.items.length > 0)
    .map((section) => ({
      type: section.type,
      label: section.label,
      points: section.points,
      chars: section.chars,
      questions: section.questions,
      items: section.items.map((item) => ({ ...item, hash: item.hash || itemFingerprint(item) })),
    }))
  const totalPoints = sections.reduce((sum, section) => sum + section.points, 0)
  return {
    id: newPaperId(),
    title: title || blueprint.title || '未命名试卷',
    mode: blueprint.mode ?? 'free',
    blueprint: {
      id: blueprint.id ?? null,
      duration_min: blueprint.duration_min ?? durationMin ?? 180,
      sections: (blueprint.sections ?? []).map((section) => ({
        type: section.type,
        count: section.count,
        points: section.points,
        chars: section.chars ?? null,
        constraints: section.constraints ?? null,
      })),
    },
    duration_min: durationMin ?? blueprint.duration_min ?? 180,
    total_points: totalPoints,
    created_at: nowIso(),
    sections,
  }
}

/** 近期做过的题：最近 5 份试卷 + 最近 5 份成绩 + 进行中的考试。 */
export async function recentItemIds(store) {
  const ids = new Set()
  const papers = (await store.listPapers()).slice(0, 5)
  for (const summary of papers) {
    const paper = await store.getPaper(summary.id)
    for (const section of paper?.sections ?? []) {
      for (const item of section.items ?? []) if (item.id) ids.add(item.id)
    }
  }
  const reports = (await store.listReports()).slice(0, 5)
  for (const summary of reports) {
    const report = await store.getReport(summary.id)
    for (const section of report?.sections ?? []) {
      for (const item of section.items ?? []) if (item.item_id) ids.add(item.item_id)
    }
  }
  const exams = await store.exams()
  for (const exam of exams) {
    if (!['running', 'paused', 'ready'].includes(exam.status)) continue
    const paper = await store.getPaper(exam.paper_id)
    for (const section of paper?.sections ?? []) {
      for (const item of section.items ?? []) if (item.id) ids.add(item.id)
    }
  }
  return ids
}

export function sectionPointsPerQuestion(section) {
  if (section.type === 'reading') {
    const total = (section.items ?? []).reduce((sum, item) => sum + (item.questions?.length ?? 0), 0)
    return total > 0 ? section.points / total : 0
  }
  const total = (section.items ?? []).length
  return total > 0 ? section.points / total : 0
}

export function describePaper(paper) {
  return (paper.sections ?? []).map((section) => ({
    type: section.type,
    label: section.label,
    points: section.points,
    items: section.items.length,
    questions: section.questions ?? section.items.length,
    chars: section.chars ?? 0,
  }))
}

export { OBJECTIVE_TYPES, PRACTICE_TYPES }


