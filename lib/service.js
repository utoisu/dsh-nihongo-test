/**
 * 服务层：一次实现，两个调用方（页面 API 与 Agent 工具）。
 *
 * 所有业务规则都在这一个文件里，HTTP 层与工具层只做参数搬运与渲染。
 * 这样「页面上能做的」和「Agent 能做的」不会各长一套逻辑。
 */
import path from 'node:path'
import { promises as fs } from 'node:fs'
import {
  TYPES,
  TYPE_LABEL,
  PRACTICE_TYPES,
  countChars,
  ensureDir,
  nowIso,
  round1,
  truncate,
} from './util.js'
import { itemFingerprint, normalizeItem, redactItem, summarizeItem } from './model.js'
import {
  BLUEPRINTS,
  blueprintById,
  buildPaper,
  composeSections,
  describePaper,
  makeRng,
  newPaperId,
  recentItemIds,
  sectionPointsPerQuestion,
  usableForPaper,
} from './paper.js'
import {
  answerKey,
  examView,
  isExpired,
  newExam,
  pauseExam,
  remainingMs,
  resumeExam,
  setAnswer as applyAnswer,
  startExam,
  submitExam,
  usedMs,
  usedPauseMs,
} from './exam.js'
import { buildReport, applyReviews } from './grader.js'
import { corpusToCandidates, makeBatchId, readCorpus, scanText } from './importer.js'

const ACTIVE = new Set(['ready', 'running', 'paused'])

function fail(message, code = 'BAD_REQUEST') {
  const error = new Error(message)
  error.code = code
  throw error
}

function cleanTitle(value, fallback) {
  const title = String(value ?? '').trim().replace(/\s+/gu, ' ')
  return title || fallback
}

export class CattiService {
  constructor({ store, logger = () => {}, ctx = null }) {
    this.store = store
    this.logger = logger
    this.ctx = ctx
    this.gradeJobs = new Map()
    // 同一场考试的写操作串行化：读-改-写不能并发，否则后写的把先写的答案盖掉。
    this.examQueues = new Map()
  }

  #withExamLock(key, operation) {
    const previous = this.examQueues.get(key) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(operation)
    this.examQueues.set(key, next.catch(() => {}))
    return next
  }

  // ------------------------------------------------------------ 概览

  async state() {
    const stats = await this.store.stats()
    const exams = (await this.store.exams()).filter((exam) => ACTIVE.has(exam.status))
    const activeExam = exams.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0] ?? null
    return {
      ...stats,
      exam: activeExam ? examView(activeExam, null) : null,
      exam_ids: exams.map((exam) => ({ id: exam.id, status: exam.status, paper_title: exam.paper_title })),
      blueprints: Object.values(BLUEPRINTS).map((blueprint) => ({
        id: blueprint.id,
        title: blueprint.title,
        duration_min: blueprint.duration_min,
        sections: blueprint.sections.map((section) => ({
          type: section.type,
          label: section.label,
          count: section.count,
          points: section.points,
          chars: section.chars ?? null,
        })),
      })),
      server_now: Date.now(),
    }
  }

  async health() {
    const banks = await this.store.allBanks()
    const issues = []
    let objective = 0
    let ai = 0
    for (const type of TYPES) {
      const items = banks[type]
      const active = items.filter((item) => item.status === 'active')
      const missing = active.filter((item) =>
        type === 'reading'
          ? (item.questions ?? []).some((question) => !question.answer)
          : PRACTICE_TYPES.has(type)
            ? false
            : !item.answer,
      )
      if (missing.length > 0) issues.push({ type, kind: 'active_without_answer', count: missing.length, ids: missing.slice(0, 5).map((item) => item.id) })
      const needsHuman = items.filter((item) => item.status === 'needs_human')
      if (needsHuman.length > 0) issues.push({ type, kind: 'needs_human', count: needsHuman.length, ids: needsHuman.slice(0, 5).map((item) => item.id) })
      if (!PRACTICE_TYPES.has(type)) {
        objective += active.length
        ai += active.filter((item) => item.answer_src === 'ai_solved').length
      }
    }
    const ratio = objective > 0 ? ai / objective : 0
    return {
      ai_answer_ratio: round1(ratio * 100) / 100,
      ai_answer_warning: ratio > 0.2,
      issues,
      counts: Object.fromEntries(TYPES.map((type) => [type, banks[type].length])),
    }
  }

  // ------------------------------------------------------------ 题库

  async bankList({ type, status, difficulty, exam_kind, level, wrongOnly, wrong_only, q, offset, limit } = {}) {
    if (!TYPES.includes(type)) fail(`未知题型：${type}`)
    if (wrongOnly === true || wrongOnly === 'true' || wrong_only === true || wrong_only === 'true') {
      const rows = await this.store.wrongList()
      const ids = new Set(rows.filter((row) => row.type === type).map((row) => row.id))
      const result = await this.store.listBank(type, { status, difficulty, exam_kind, level, q, offset: 0, limit: 100000 })
      const filtered = result.items.filter((item) => ids.has(item.id))
      const start = Math.max(0, Number(offset) || 0)
      const size = Math.min(200, Math.max(1, Number(limit) || 100))
      return { total: filtered.length, offset: start, limit: size, items: filtered.slice(start, start + size) }
    }
    return this.store.listBank(type, { status, difficulty, exam_kind, level, q, offset, limit })
  }

  async bankGet({ type, id } = {}) {
    if (!TYPES.includes(type)) fail(`未知题型：${type}`)
    const item = await this.store.getItem(type, id)
    if (!item) fail(`找不到 ${id}`, 'NOT_FOUND')
    return { item, summary: summarizeItem(item) }
  }

  async bankStatus({ type, id, status, ids } = {}) {
    if (!TYPES.includes(type)) fail(`未知题型：${type}`)
    const allowed = ['candidate', 'active', 'disputed', 'rejected', 'needs_human']
    if (!allowed.includes(status)) fail(`未知状态：${status}`)
    const targets = Array.isArray(ids) && ids.length > 0 ? ids : [id]
    const changed = []
    for (const target of targets) {
      try {
        await this.store.setStatus(type, target, status)
        changed.push(target)
      } catch (error) {
        this.logger(`[catti] setStatus ${type}/${target}: ${error.message}`)
      }
    }
    await this.store.appendAudit({ kind: 'status', type, ids: changed, status })
    return { changed, count: changed.length, status }
  }

  async bankDelete({ type, id } = {}) {
    if (!TYPES.includes(type)) fail(`未知题型：${type}`)
    const removed = await this.store.removeItem(type, id)
    await this.store.appendAudit({ kind: 'delete', type, id, removed })
    return { removed }
  }

  async bankAdd({ type, item } = {}) {
    if (!TYPES.includes(type)) fail(`未知题型：${type}`)
    const normalized = normalizeItem(type, item, { batch: 'manual' })
    normalized.status = 'candidate'
    normalized.source = normalized.source || '手工录入'
    const result = await this.store.addItems(type, [normalized])
    await this.store.appendAudit({ kind: 'manual_add', type, ids: result.added })
    return { ...result, item: normalized }
  }

  /**
   * 人工改题：整条重新规范化后覆盖（题干/选项/答案/解析/译文/题材…）。
   * 状态、创建时间、批次不动——编辑不是审核动作。
   */
  async bankUpdate({ type, id, patch } = {}) {
    if (!TYPES.includes(type)) fail(`未知题型：${type}`)
    if (!id) fail('缺少 id')
    if (!patch || typeof patch !== 'object') fail('缺少要改的字段')
    const existing = await this.store.getItem(type, id)
    if (!existing) fail(`找不到 ${id}`, 'NOT_FOUND')
    const merged = { ...existing }
    const editable = [
      'stem', 'options', 'answer', 'explanation', 'point',
      'passage', 'questions', 'title',
      'text', 'ref', 'rubric',
      'topic', 'difficulty', 'tags', 'source', 'notes',
      'exam_kind', 'year', 'full_text',
    ]
    for (const key of editable) {
      if (patch[key] !== undefined) merged[key] = patch[key]
    }
    const normalized = normalizeItem(type, merged, { id })
    normalized.id = existing.id
    normalized.status = existing.status
    normalized.created_at = existing.created_at
    normalized.audit_batch = existing.audit_batch
    normalized.ai_extracted = existing.ai_extracted
    normalized.hash = itemFingerprint(normalized)
    const saved = await this.store.putItem(type, normalized)
    await this.store.appendAudit({
      kind: 'item_update',
      type,
      id,
      fields: Object.keys(patch).filter((key) => editable.includes(key)),
    })
    return { item: saved, summary: summarizeItem(saved) }
  }

  // ------------------------------------------------------------ 导入

  async importScan({ type, text, format = 'auto', source = '', batch } = {}) {
    if (!TYPES.includes(type)) fail(`未知题型：${type}`)
    const id = batch || makeBatchId('B')
    const result = scanText({ type, format, text, source, batch: id })
    await this.store.appendAudit({
      kind: 'import_scan',
      type,
      batch: id,
      total: result.total,
      ok: result.ok,
      failed: result.failed,
    })
    return result
  }

  async importCommit({ type, items, batch, source = '' } = {}) {
    if (!TYPES.includes(type)) fail(`未知题型：${type}`)
    if (!Array.isArray(items) || items.length === 0) fail('没有要入库的条目')
    const id = batch || makeBatchId('B')
    const normalized = []
    const rejected = []
    for (const entry of items) {
      try {
        const item = normalizeItem(type, entry, { batch: id })
        item.audit_batch = id
        item.source = item.source || source || '导入'
        if (item.status === 'active') item.status = 'candidate'
        normalized.push(item)
      } catch (error) {
        rejected.push({ id: entry?.id ?? '', error: String(error?.message ?? error) })
      }
    }
    const result = await this.store.addItems(type, normalized)
    await this.store.appendAudit({
      kind: 'import_commit',
      type,
      batch: id,
      added: result.added.length,
      skipped: result.skipped.length,
      rejected: rejected.length,
    })
    return { batch: id, type, added: result.added, skipped: result.skipped, rejected }
  }

  async importCorpus({ kind = 'L', limit = 3000, path: customPath } = {}) {
    const file = customPath || this.store.corpusPath
    if (!file) fail('未配置语料路径（corpusPath）', 'NO_CORPUS')
    let list
    try {
      list = await readCorpus(file)
    } catch (error) {
      fail(`读不到语料文件：${file}（${error.message}）`, 'NO_CORPUS')
    }
    const batch = makeBatchId('C')
    const perType = Math.max(1, Math.floor((Number(limit) || 3000) / 2))
    const converted = corpusToCandidates(list, { kind, batch, limit: perType * 2 })
    const byType = { ja2zh: [], zh2ja: [] }
    for (const candidate of converted.candidates) {
      const bucket = byType[candidate.item.type]
      if (bucket.length >= perType) continue
      bucket.push(candidate.item)
    }
    const added = {}
    for (const type of ['ja2zh', 'zh2ja']) {
      const slice = byType[type]
      added[type] = slice.length === 0
        ? { added: [], skipped: [] }
        : await this.store.addItems(type, slice)
    }
    await this.store.appendAudit({
      kind: 'import_corpus',
      file,
      kind,
      batch,
      ja2zh: added.ja2zh?.added.length ?? 0,
      zh2ja: added.zh2ja?.added.length ?? 0,
    })
    return {
      batch,
      file,
      kind,
      full_text: kind === 'L',
      skipped_source: converted.skipped,
      ja2zh: { added: added.ja2zh?.added.length ?? 0, skipped: added.ja2zh?.skipped.length ?? 0 },
      zh2ja: { added: added.zh2ja?.added.length ?? 0, skipped: added.zh2ja?.skipped.length ?? 0 },
    }
  }

  // ------------------------------------------------------------ 组卷

  async blueprints() {
    const banks = await this.store.allBanks()
    const recent = await recentItemIds(this.store)
    return Object.values(BLUEPRINTS).map((blueprint) => ({
      ...blueprint,
      sections: blueprint.sections.map((section) => {
        const pool = banks[section.type].filter((item) => usableForPaper(item) && !recent.has(item.id))
        // 阅读一节按「题」算量：一篇短文带好几道小题，按条数算会永远显示不足
        const available = section.type === 'reading'
          ? pool.reduce((sum, item) => sum + (item.questions?.length ?? 0), 0)
          : pool.length
        return {
          ...section,
          available,
          available_items: pool.length,
        }
      }),
    }))
  }

  #blueprintFromRequest({ mode = 'template', blueprintId, sections, title, duration_min, constraints } = {}) {
    if (mode === 'template') {
      const blueprint = blueprintById(blueprintId)
      if (!blueprint) fail(`未知模板：${blueprintId}`)
      return {
        ...blueprint,
        title: cleanTitle(title, blueprint.title),
        duration_min: Number(duration_min) || blueprint.duration_min,
        constraints: constraints ?? null,
      }
    }
    if (!Array.isArray(sections) || sections.length === 0) fail('自由组卷至少要选一个题型')
    const normalizedSections = []
    for (const section of sections) {
      const type = section.type
      if (!TYPES.includes(type)) fail(`未知题型：${type}`)
      const count = Math.max(0, Number(section.count) || 0)
      if (count === 0) continue
      normalizedSections.push({
        type,
        label: section.label ?? TYPE_LABEL[type],
        count,
        points: Math.max(0, Number(section.points) || count),
        chars: Array.isArray(section.chars) ? section.chars : undefined,
        constraints: section.constraints ?? null,
        unit: type === 'reading' ? 'questions' : undefined,
      })
    }
    if (normalizedSections.length === 0) fail('自由组卷的数量都是 0')
    return {
      id: null,
      title: cleanTitle(title, '自由组卷'),
      mode: 'free',
      duration_min: Number(duration_min) || 180,
      sections: normalizedSections,
      constraints: constraints ?? null,
    }
  }

  /** constraints.wrongOnly 时，只从错题库里抽。 */
  async #wrongOnlyIds(blueprint) {
    if (!blueprint?.constraints?.wrongOnly) return null
    const rows = await this.store.wrongList()
    return new Set(rows.map((row) => row.id))
  }
  async paperCompose(request = {}) {
    const blueprint = this.#blueprintFromRequest(request)
    const banks = await this.store.allBanks()
    // 错题组卷不能按「近期做过」排掉——错题往往就是刚做完的那批
    const wrongOnlyRequested = blueprint?.constraints?.wrongOnly === true
    const excluded = request.excludeRecent === false || wrongOnlyRequested ? new Set() : await recentItemIds(this.store)
    const rng = makeRng(request.seed ?? Date.now())
    const composed = composeSections(banks, blueprint, {
      excludedIds: excluded,
      rng,
      constraints: blueprint.constraints,
      onlyIds: await this.#wrongOnlyIds(blueprint),
    })
    const preview = composed.sections.map((section) => ({
      type: section.type,
      label: section.label,
      points: section.points,
      count: section.questions,
      quota: section.quota_count,
      chars: section.chars,
      per_question: round1(sectionPointsPerQuestion(section) * 100) / 100,
      items: section.items.map((item) => ({
        id: item.id,
        title: item.title ?? '',
        preview: truncate(item.stem ?? item.text ?? item.passage ?? '', 70),
        chars: item.chars ?? 0,
        source: item.source ?? '',
        composed_of: item.composed_of ?? null,
        questions: item.questions?.length ?? null,
      })),
    }))
    const totalPoints = composed.sections.reduce((sum, section) => sum + section.points, 0)
    return {
      ok: composed.ok,
      blueprint,
      preview,
      shortfalls: composed.shortfalls,
      warnings: composed.warnings,
      total_points: totalPoints,
      duration_min: blueprint.duration_min,
      seed: request.seed ?? null,
    }
  }

  async paperCreate(request = {}) {
    const blueprint = this.#blueprintFromRequest(request)
    const banks = await this.store.allBanks()
    // 错题组卷不能按「近期做过」排掉——错题往往就是刚做完的那批
    const wrongOnlyRequested = blueprint?.constraints?.wrongOnly === true
    const excluded = request.excludeRecent === false || wrongOnlyRequested ? new Set() : await recentItemIds(this.store)
    const rng = makeRng(request.seed ?? Date.now())
    const composed = composeSections(banks, blueprint, {
      excludedIds: excluded,
      rng,
      constraints: blueprint.constraints,
      onlyIds: await this.#wrongOnlyIds(blueprint),
    })
    if (!composed.ok && request.allowShort !== true) {
      const detail = composed.shortfalls
        .map((shortfall) => `${TYPE_LABEL[shortfall.type] ?? shortfall.type}：需要 ${shortfall.need}，只有 ${shortfall.have}（${shortfall.reason}）`)
        .join('；')
      fail(`题量不够，未建卷。${detail}。可在「自由组卷」里减少题数，或先补题库。`, 'SHORTAGE')
    }
    const paper = buildPaper({
      blueprint,
      composed,
      title: blueprint.title,
      durationMin: blueprint.duration_min,
    })
    if (paper.sections.length === 0) fail('没有抽到任何题目')
    paper.id = paper.id || newPaperId()
    if (request.save === false) return { paper, saved: false }
    await this.store.savePaper(paper)
    await this.store.appendAudit({ kind: 'paper_create', paper: paper.id, title: paper.title, sections: describePaper(paper) })
    return { paper, saved: true }
  }

  async paperList() {
    return { papers: await this.store.listPapers() }
  }

  /**
   * 按年份/性质把那一年的题整卷装进一份试卷（快照）。
   * 综合 100 分（词汇 1 分/题、语法 1 分/题、阅读 2 分/题）+ 实务 100 分（日译中 40、中译日 60），300 分钟。
   */
  async paperFromYear({ year, examKind = 'real', title, duration_min } = {}) {
    const banks = await this.store.allBanks()
    const wantYear = year === null || year === undefined || year === '' ? null : Number(year)
    const kind = examKind || 'real'
    const match = (item) => item.status === 'active'
      && (kind === 'any' || (item.exam_kind ?? '') === kind)
      && (wantYear === null || Number(item.year) === wantYear)

    const vocab = banks.vocab.filter(match)
    const grammar = banks.grammar.filter(match)
    const reading = banks.reading.filter(match)
    const ja2zh = banks.ja2zh.filter(match)
    const zh2ja = banks.zh2ja.filter(match)
    const readingQuestions = reading.reduce((sum, item) => sum + (item.questions?.length ?? 0), 0)
    if (vocab.length + grammar.length + reading.length + ja2zh.length + zh2ja.length === 0) {
      fail(`没有可用的题（year=${wantYear ?? '全部'}，examKind=${kind}）`, 'NOT_FOUND')
    }

    const sections = [
      { type: 'vocab', label: '词汇选择', points: vocab.length, questions: vocab.length, chars: 0, items: vocab },
      { type: 'grammar', label: '语法', points: grammar.length, questions: grammar.length, chars: 0, items: grammar },
      { type: 'reading', label: '阅读理解', points: readingQuestions * 2, questions: readingQuestions, chars: 0, items: reading },
      { type: 'ja2zh', label: '日译中', points: 40, questions: ja2zh.length, chars: ja2zh.reduce((sum, item) => sum + (item.chars ?? 0), 0), items: ja2zh },
      { type: 'zh2ja', label: '中译日', points: 60, questions: zh2ja.length, chars: zh2ja.reduce((sum, item) => sum + (item.chars ?? 0), 0), items: zh2ja },
    ].filter((section) => section.items.length > 0)

    const defaultTitle = wantYear
      ? `${wantYear} ${kind === 'mock' ? '模拟' : '真题'} · 全卷`
      : `${kind === 'mock' ? '模拟试题' : '真题'} · 全卷`
    const composed = { sections: sections.map((section) => ({ ...section })) }
    const paper = buildPaper({
      blueprint: { id: null, title: defaultTitle, mode: 'year', duration_min: Number(duration_min) || 300, sections: [] },
      composed,
      title: cleanTitle(title, defaultTitle),
      durationMin: Number(duration_min) || 300,
    })
    paper.year = wantYear
    paper.exam_kind = kind
    await this.store.savePaper(paper)
    await this.store.appendAudit({
      kind: 'paper_from_year',
      paper: paper.id,
      year: wantYear,
      exam_kind: kind,
      sections: describePaper(paper),
    })
    return { paper }
  }

  async paperGet({ paperId } = {}) {
    const paper = await this.store.getPaper(paperId)
    if (!paper) fail(`找不到试卷 ${paperId}`, 'NOT_FOUND')
    const exams = (await this.store.exams()).filter((exam) => exam.paper_id === paperId && ACTIVE.has(exam.status))
    const redact = exams.length > 0
    return {
      paper: redact ? redactPaper(paper) : paper,
      redacted: redact,
      active_exam_id: exams[0]?.id ?? null,
    }
  }

  async paperDelete({ paperId } = {}) {
    const paper = await this.store.getPaper(paperId)
    if (!paper) fail(`找不到试卷 ${paperId}`, 'NOT_FOUND')
    const running = (await this.store.exams()).filter(
      (exam) => exam.paper_id === paperId && ACTIVE.has(exam.status),
    )
    if (running.length > 0) fail('这份试卷还有进行中的考试，先交卷再删。', 'EXAM_BUSY')
    await this.store.removePaper(paperId)
    await this.store.appendAudit({ kind: 'paper_delete', paper: paperId })
    return { removed: true, paperId }
  }

  // ------------------------------------------------------------ 考试

  async examActive() {
    const exams = (await this.store.exams()).filter((exam) => ACTIVE.has(exam.status))
    const exam = exams.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0] ?? null
    if (!exam) return null
    if (isExpired(exam, Date.now())) {
      await this.#withExamLock(exam.id, () => this.#submitExam(exam.id, 'timeout'))
      return null
    }
    return exam
  }

  async examStart({ paperId } = {}) {
    if (!paperId) fail('缺少 paperId')
    const running = await this.examActive()
    if (running && running.id) {
      if (running.paper_id === paperId) {
        const paper = await this.store.getPaper(paperId)
        return { exam: examView(running, paper), resumed: true, paper: redactPaper(paper) }
      }
      fail(`已有进行中的考试（${running.paper_title}）。先交卷或放弃它，再开新卷。`, 'EXAM_BUSY')
    }
    const paper = await this.store.getPaper(paperId)
    if (!paper) fail(`找不到试卷 ${paperId}`, 'NOT_FOUND')
    const exam = newExam(paper)
    startExam(exam)
    await this.store.saveExam(exam)
    await this.store.appendAudit({ kind: 'exam_start', exam: exam.id, paper: paper.id })
    return { exam: examView(exam, paper), paper: redactPaper(paper), resumed: false }
  }

  async examState({ examId } = {}) {
    let exam = null
    if (examId) {
      exam = (await this.store.exams()).find((entry) => entry.id === examId) ?? null
      if (!exam) fail(`找不到考试 ${examId}`, 'NOT_FOUND')
    } else {
      exam = await this.examActive()
    }
    if (!exam) return { exam: null, paper: null }
    const paper = await this.store.getPaper(exam.paper_id)
    if (!paper) fail('试卷文件丢失，无法继续这场考试', 'PAPER_LOST')
    if (isExpired(exam, Date.now())) {
      const graded = await this.#withExamLock(exam.id, () => this.#submitExam(exam.id, 'timeout'))
      return { exam: graded.exam, paper: redactPaper(paper), report: graded.report, auto_submitted: true }
    }
    return { exam: examView(exam, paper), paper: redactPaper(paper), auto_submitted: false }
  }

  async examAnswer({ examId, key, value } = {}) {
    return this.#withExamLock(examId ?? 'active', async () => {
      const exam = await this.#requireExam(examId)
      if (exam.status !== 'running') fail('当前不在作答状态', 'EXAM_NOT_RUNNING')
      if (!/^\d+:\d+(:\d+)?$/u.test(String(key ?? ''))) fail('答案坐标不合法')
      applyAnswer(exam, key, value)
      await this.store.saveExam(exam)
      return { saved_at: nowIso(), key, length: String(value ?? '').length }
    })
  }

  async examPause({ examId } = {}) {
    return this.#withExamLock(examId ?? 'active', async () => {
      const exam = await this.#requireExam(examId)
      if (exam.status !== 'running') fail('只有作答中的考试可以暂停', 'EXAM_NOT_RUNNING')
      pauseExam(exam)
      await this.store.saveExam(exam)
      return { exam: examView(exam, null) }
    })
  }

  async examResume({ examId } = {}) {
    return this.#withExamLock(examId ?? 'active', async () => {
      const exam = await this.#requireExam(examId)
      if (exam.status !== 'paused') fail('这场考试没有暂停', 'EXAM_NOT_PAUSED')
      resumeExam(exam)
      await this.store.saveExam(exam)
      return { exam: examView(exam, null) }
    })
  }

  async examSubmit({ examId, reason = 'manual' } = {}) {
    return this.#withExamLock(examId ?? 'active', async () => {
      const exam = await this.#requireExam(examId)
      if (exam.status === 'ready') fail('这场考试还没开始', 'EXAM_NOT_RUNNING')
      if (exam.status === 'graded' || exam.status === 'submitted') {
        const report = exam.report_id ? await this.store.getReport(exam.report_id) : null
        return { exam: examView(exam, null), report }
      }
      return this.#submitExam(exam, reason)
    })
  }

  async #submitExam(examRef, reason) {
    const exam = typeof examRef === 'string' ? await this.#requireExam(examRef) : examRef
    if (exam.status === 'graded' || exam.status === 'submitted') {
      const existing = exam.report_id ? await this.store.getReport(exam.report_id) : null
      return { exam: examView(exam, null), report: existing }
    }
    const paper = await this.store.getPaper(exam.paper_id)
    if (!paper) fail('试卷文件丢失，无法判卷', 'PAPER_LOST')
    const now = Date.now()
    // 先记下交卷原因，buildReport 会把它写进成绩单（否则一律显示「手动交卷」）。
    exam.submit_reason = reason
    const report = buildReport({ paper, exam, now })
    await this.store.saveReport(report)
    await this.#recordWrongFromReport(report, exam)
    await this.store.saveExam(exam)
    await this.store.appendAudit({
      kind: 'exam_submit',
      exam: exam.id,
      paper: paper.id,
      report: report.id,
      reason,
      total: report.total,
    })
    return { exam: examView(exam, paper), report }
  }

  async #requireExam(examId) {
    const exams = await this.store.exams()
    const exam = examId
      ? exams.find((entry) => entry.id === examId)
      : exams.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).find((entry) => ACTIVE.has(entry.status))
    if (!exam) fail('没有找到这场考试（可能已经交卷）', 'NOT_FOUND')
    return exam
  }

  /** 到点自动交卷；由 Host 定时器与每次页面轮询共同触发。 */
  async tick() {
    const exams = (await this.store.exams()).filter((exam) => exam.status === 'running')
    const autoSubmitted = []
    for (const exam of exams) {
      if (!isExpired(exam, Date.now())) continue
      try {
        const result = await this.#withExamLock(exam.id, () => this.#submitExam(exam.id, 'timeout'))
        if (result.report) autoSubmitted.push({ exam_id: exam.id, report_id: result.report.id })
      } catch (error) {
        this.logger(`[catti] auto submit ${exam.id} failed: ${error.message}`)
      }
    }
    return { auto_submitted: autoSubmitted }
  }

  // ------------------------------------------------------------ 成绩

  async reportList() {
    return { reports: await this.store.listReports() }
  }

  async reportGet({ reportId } = {}) {
    const report = await this.store.getReport(reportId)
    if (!report) fail(`找不到成绩单 ${reportId}`, 'NOT_FOUND')
    const paper = await this.store.getPaper(report.paper_id)
    return { report, paper: paper ? { id: paper.id, title: paper.title } : null }
  }

  async reportDelete({ reportId } = {}) {
    const report = await this.store.getReport(reportId)
    if (!report) fail(`找不到成绩单 ${reportId}`, 'NOT_FOUND')
    await this.store.removeReport(reportId)
    const exams = await this.store.exams()
    const exam = exams.find((entry) => entry.report_id === reportId)
    if (exam) {
      exam.report_id = null
      exam.status = 'submitted'
      await this.store.saveExam(exam)
    }
    await this.store.appendAudit({ kind: 'report_delete', report: reportId })
    return { removed: true, reportId }
  }

  async reportExport({ reportId, format = 'md' } = {}) {    const report = await this.store.getReport(reportId)
    if (!report) fail(`找不到成绩单 ${reportId}`, 'NOT_FOUND')
    if (format !== 'md') fail('MVP 只支持导出 Markdown；Word 导出在 v1')
    const markdown = renderReportMarkdown(report)
    const dir = path.join(this.store.dataDir, 'exports')
    await ensureDir(dir)
    const file = path.join(dir, `${report.id}.md`)
    await fs.writeFile(file, markdown, 'utf8')
    return { file, markdown }
  }

  // ------------------------------------------------------------ 实务判分（主会话写回）

  // ---------------------------------------------------------- 错题库

  /** 交卷后把错的客观题登记进错题库（同一题再错只加次数）。 */
  async #recordWrongFromReport(report, exam) {
    const entries = []
    for (const section of report.sections ?? []) {
      if (PRACTICE_TYPES.has(section.type)) continue
      for (const item of section.items ?? []) {
        const answered = (item.questions ?? []).filter((question) => question.user_answer)
        const wrong = answered.some((question) => question.correct === false)
        if (wrong) entries.push({ type: section.type, id: item.item_id, exam: exam?.id ?? '', report: report.id })
      }
    }
    if (entries.length > 0) await this.store.recordWrong(entries)
    return entries.length
  }

  /** 错题库列表：带上题目摘要，页面和组卷都吃它。 */
  async wrongList({ type, limit = 200 } = {}) {
    const rows = await this.store.wrongList()
    const banks = await this.store.allBanks()
    const out = []
    for (const row of rows) {
      if (type && row.type !== type) continue
      const item = (banks[row.type] ?? []).find((entry) => entry.id === row.id)
      if (!item) continue
      out.push({ ...row, item: summarizeItem(item) })
    }
    out.sort((a, b) => String(b.last_at).localeCompare(String(a.last_at)))
    return { total: out.length, items: out.slice(0, Math.max(1, Number(limit) || 200)) }
  }

  async wrongClear({ type, id } = {}) {
    const kept = await this.store.clearWrong({ type, id })
    await this.store.appendAudit({ kind: 'wrong_clear', type: type ?? 'all', id: id ?? 'all', left: kept.length })
    return { left: kept.length }
  }

  /** 哪些成绩单在等实务评分。 */
  async gradePending() {
    const reports = await this.store.listReports()
    const pending = reports
      .filter((report) => report.status === 'pending_review')
      .map((report) => ({
        report_id: report.id,
        paper_title: report.paper_title,
        submitted_at: report.submitted_at,
        pending_sections: report.sections
          .map((section, index) => ({ section, index }))
          .filter(({ section }) => PRACTICE_TYPES.has(section.type) && section.graded !== true)
          .map(({ section, index }) => ({ section_index: index, label: section.label, max: section.max })),
      }))
    return { pending }
  }

  /** 给主会话的评分材料：原文 + 考生译文 + 参考译文 + 采分点 + 输出契约。 */
  async gradeMaterial({ reportId } = {}) {
    const report = await this.store.getReport(reportId)
    if (!report) fail(`找不到成绩单 ${reportId}`, 'NOT_FOUND')
    const sections = (report.sections ?? [])
      .map((section, index) => ({ section, index }))
      .filter(({ section }) => PRACTICE_TYPES.has(section.type) && section.graded !== true)
      .map(({ section, index }) => ({
        section_index: index,
        label: section.label,
        max: section.max,
        answered: section.answered ?? 0,
        items: (section.items ?? []).map((item) => ({
          item_id: item.item_id,
          title: item.title,
          original: item.text ?? '',
          translation: item.answer ?? '',
          answered: Boolean(item.answered),
          reference: item.ref_src === 'official' ? item.ref : '',
          reference_note: item.ref_src === 'ai_solved' ? '参考译文是 AI 补的，只作提示，不能当标尺' : '',
          rubric: item.rubric ?? [],
          chars: item.chars ?? 0,
        })),
      }))
    if (sections.length === 0) {
      fail(`成绩单 ${reportId} 没有待判分的实务段（status=${report.status}）`, 'NOTHING_TO_GRADE')
    }
    return {
      report_id: report.id,
      paper_title: report.paper_title,
      submitted_at: report.submitted_at,
      status: report.status,
      sections,
      threshold: 3,
      contract: {
        note: '每个评审独立看原文判忠实度，不拿机器译文当标尺；子智能体只产出下面的 JSON，不写文件。',
        review_json: {
          section_index: '整数，等于上面的 section_index',
          reviewer: 'A / B / C',
          score: '该段得分（0..max，一位小数）',
          breakdown: { 忠实: 0, 通顺: 0, 术语: 0, 格式: 0 },
          points: [{ 点: '采分点', 判定: '译到 / 部分 / 漏', 位置: '第2句' }],
          errors: [{ 原文: '…', 译文: '…', 类型: '错译/漏译/语体/术语/数字', 理由: '…' }],
        },
        commit_tool: 'catti_grade',
        commit_action: 'commit',
        commit_payload_example: {
          reportId: report.id,
          threshold: 3,
          reviews: [
            { section_index: 0, reviewer: 'A', score: 42.5 },
            { section_index: 0, reviewer: 'B', score: 44 },
          ],
        },
        rule: 'A、B 相差 ≤ threshold 取均值；超过阈值要补第三评 C，三评取均值。缺任何一份会被拒。',
      },
    }
  }

  /** 把双评/三评写回成绩单；齐了就转 graded。 */
  async gradeCommit({ reportId, reviews, threshold = 3, source = 'catti_grade' } = {}) {
    const report = await this.store.getReport(reportId)
    if (!report) fail(`找不到成绩单 ${reportId}`, 'NOT_FOUND')
    if (!Array.isArray(reviews) || reviews.length === 0) fail('没有评分可写回')
    applyReviews(report, reviews, { threshold: Number(threshold) || 3, source })
    await this.store.saveReport(report)
    await this.store.appendAudit({
      kind: 'grade_commit',
      report: report.id,
      status: report.status,
      total: report.total,
      max: report.max,
    })
    return { report, status: report.status }
  }

  // ------------------------------------------------------------ 页面上的一键批改（插件内调模型）

  /** 当前默认模型；宿主没给就报清楚。 */
  #modelSelection() {
    const adm = this.ctx?.get?.('agentDefaultModel')
    const selection = adm?.currentSelection?.()
    if (selection && selection.provider && selection.model) return selection
    fail('宿主没有默认模型选择，改回会话里用 catti_grade 评', 'NO_MODEL')
  }

  /** 问一次模型，把流式文本拼起来。 */
  async #askModel(system, user, { maxTokens = 12000 } = {}) {
    const llm = this.ctx?.get?.('llm')
    if (!llm?.stream) fail('宿主没有 llm 服务，改回会话里用 catti_grade 评', 'NO_LLM')
    const selection = this.#modelSelection()
    const stream = llm.stream({
      provider: selection.provider,
      model: selection.model,
      // 批改要的是稳定的结构化输出，不是深度推理：默认模型可能选了 max 档，
      // 那样会把 token 全烧在推理上、拿不到文本。这里压到 low。
      reasoningEffort: this.gradeReasoningEffort || 'low',
      system,
      messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
      maxTokens,
    })
    let text = ''
    let reasoning = ''
    let blocks = ''
    let finishKind = ''
    const seen = new Set()
    for await (const chunk of stream) {
      seen.add(chunk.type === 'block-end' ? `block-end:${chunk.block?.type}` : chunk.type)
      if (chunk.type === 'text-delta') text += chunk.text
      if (chunk.type === 'reasoning-delta') reasoning += chunk.text
      if (chunk.type === 'block-end' && chunk.block?.type === 'text') blocks += chunk.block.text ?? ''
      if (chunk.type === 'finish') finishKind = chunk.reason?.kind ?? 'unknown'
      if (chunk.type === 'finish' && chunk.reason?.kind === 'error') {
        fail(`模型调用失败：${chunk.reason.failure?.message ?? '未知错误'}`, 'MODEL_ERROR')
      }
      if (chunk.type === 'finish' && chunk.reason?.kind === 'aborted') fail('模型调用被中断', 'MODEL_ABORTED')
    }
    if (!text && blocks) text = blocks
    // 有些模型只吐推理块：推理里出现 JSON 就直接用，别浪费一次调用
    if (!text.trim() && reasoning.includes('{')) text = reasoning
    if (!text.trim()) fail(`模型返回了空文本（收到的块：${[...seen].join(' / ') || '无'}）`, 'EMPTY_MODEL_OUTPUT')
    return { text, selection }
  }

  /** 从模型输出里抠出第一个完整 JSON 对象。 */
  #extractJson(text) {
    const body = String(text ?? '')
    const candidates = []
    let depth = 0
    let from = -1
    let inString = false
    let escape = false
    for (let index = 0; index < body.length; index += 1) {
      const ch = body[index]
      if (inString) {
        if (escape) escape = false
        else if (ch === '\\') escape = true
        else if (ch === '"') inString = false
        continue
      }
      if (ch === '"') inString = true
      else if (ch === '{') {
        if (depth === 0) from = index
        depth += 1
      } else if (ch === '}') {
        depth -= 1
        if (depth === 0 && from >= 0) {
          candidates.push(body.slice(from, index + 1))
          from = -1
          if (candidates.length >= 12) break
        }
      }
    }
    for (const candidate of candidates) {
      try {
        const parsed = JSON.parse(candidate)
        // 认「像评分结果」的那个：要有 score
        if (parsed && typeof parsed === 'object' && parsed.score !== undefined) return parsed
      } catch {
        /* 试下一个 */
      }
    }
    for (const candidate of candidates) {
      try {
        return JSON.parse(candidate)
      } catch {
        /* 试下一个 */
      }
    }
    fail('模型输出里没有可用的 JSON', 'BAD_MODEL_OUTPUT')
  }
  async #reviewSection(material, section, reviewer, selectionNote) {
    const system = [
      '你是 CATTI 日语笔译二级实务的阅卷老师。',
      '只看原文判断译文是否忠实、通顺、术语与格式是否得当；参考译文只作提示，不能当唯一标尺。',
      '分数按该段满分折算，一位小数。',
      '只输出一个 JSON 对象，不要解释、不要 Markdown 代码块以外的文字。',
      'JSON 结构：{"score": 数字, "breakdown": {"忠实": 数字, "通顺": 数字, "术语": 数字, "格式": 数字}, "points": [{"点": "采分点", "判定": "译到/部分/漏", "位置": "第2句"}], "errors": [{"原文": "…", "译文": "…", "类型": "错译/漏译/语体/术语/数字", "理由": "…"}]}',
    ].join('\n')
    const payload = {
      该段: section.label,
      满分: section.max,
      评审: reviewer,
      段落: section.items.map((item) => ({
        原文: item.original,
        考生译文: item.translation,
        参考译文: item.reference || '（没有）',
        采分点: item.rubric,
        字数: item.chars,
      })),
    }
    const { text } = await this.#askModel(system, JSON.stringify(payload, null, 2))
    const parsed = this.#extractJson(text)
    const score = Math.max(0, Math.min(Number(section.max) || 100, Number(parsed.score) || 0))
    return {
      score: Math.round(score * 10) / 10,
      breakdown: parsed.breakdown ?? null,
      points: Array.isArray(parsed.points) ? parsed.points : [],
      errors: Array.isArray(parsed.errors) ? parsed.errors : [],
      raw: text.slice(0, 4000),
      model: selectionNote,
    }
  }

  /** 自检：问模型一句话，看它能不能正常吐文本（排障用）。 */
  async gradePing() {
    const { text, selection } = await this.#askModel('你只回复一个 JSON 对象，不要别的内容。', '输出 {"ok":true}')
    return { selection, text: text.slice(0, 400) }
  }

  /** 一键批改：起一个后台任务，页面轮询状态。 */
  async gradeStart({ reportId, threshold = 3 } = {}) {
    if (!reportId) fail('缺少 reportId')
    const report = await this.store.getReport(reportId)
    if (!report) fail(`找不到成绩单 ${reportId}`, 'NOT_FOUND')
    const existing = this.gradeJobs.get(reportId)
    if (existing && existing.state === 'running') return { job: { ...existing, reportId } }
    const job = { state: 'running', started_at: nowIso(), progress: '准备材料', error: '', reviews: 0 }
    this.gradeJobs.set(reportId, job)
    void (async () => {
      try {
        const material = await this.gradeMaterial({ reportId })
        const selection = this.#modelSelection()
        const selectionNote = `${selection.provider}/${selection.model}`
        const reviews = []
        for (const section of material.sections) {
          job.progress = `${section.label}：A 评`
          const a = await this.#reviewSection(material, section, 'A', selectionNote)
          reviews.push({ section_index: section.section_index, reviewer: 'A', ...a })
          job.progress = `${section.label}：B 评`
          const b = await this.#reviewSection(material, section, 'B', selectionNote)
          reviews.push({ section_index: section.section_index, reviewer: 'B', ...b })
          if (Math.abs(a.score - b.score) > (Number(threshold) || 3)) {
            job.progress = `${section.label}：两次差 ${Math.abs(a.score - b.score).toFixed(1)}，C 评`
            const c = await this.#reviewSection(material, section, 'C', selectionNote)
            reviews.push({ section_index: section.section_index, reviewer: 'C', ...c })
          }
          job.reviews = reviews.length
        }
        job.progress = '写回成绩单'
        const result = await this.gradeCommit({ reportId, reviews, threshold, source: 'in_app' })
        job.state = 'done'
        job.progress = `已判分（${result.status}）`
        job.total = result.report.total
        job.max = result.report.max
      } catch (error) {
        job.state = 'error'
        job.error = error?.message ?? String(error)
      }
    })()
    return { job: { ...job, reportId } }
  }

  async gradeStatus({ reportId } = {}) {
    if (!reportId) fail('缺少 reportId')
    const job = this.gradeJobs.get(reportId)
    if (!job) return { job: null }
    return { job: { ...job, reportId } }
  }

  // ------------------------------------------------------------ 通用

  async handle(action, payload = {}) {
    const method = this.dispatch[action]
    if (!method) fail(`未知操作：${action}`, 'UNKNOWN_ACTION')
    return method.call(this, payload)
  }

  get dispatch() {
    return {
      state: this.state,
      health: this.health,
      'bank.list': this.bankList,
      'bank.get': this.bankGet,
      'bank.status': this.bankStatus,
      'bank.update': this.bankUpdate,
      'bank.delete': this.bankDelete,
      'bank.add': this.bankAdd,
      'import.scan': this.importScan,
      'import.commit': this.importCommit,
      'import.corpus': this.importCorpus,
      'paper.blueprints': this.blueprints,
      'paper.compose': this.paperCompose,
      'paper.create': this.paperCreate,
      'paper.from_year': this.paperFromYear,
      'paper.list': this.paperList,
      'paper.get': this.paperGet,
      'paper.delete': this.paperDelete,
      'exam.start': this.examStart,
      'exam.state': this.examState,
      'exam.answer': this.examAnswer,
      'exam.pause': this.examPause,
      'exam.resume': this.examResume,
      'exam.submit': this.examSubmit,
      'exam.tick': this.tick,
      'grade.pending': this.gradePending,
      'grade.material': this.gradeMaterial,
      'grade.commit': this.gradeCommit,
      'grade.ping': this.gradePing,
      'wrong.list': this.wrongList,
      'wrong.clear': this.wrongClear,
      'grade.start': this.gradeStart,
      'grade.status': this.gradeStatus,
      'report.list': this.reportList,
      'report.get': this.reportGet,
      'report.delete': this.reportDelete,
      'report.export': this.reportExport,
    }
  }
}

export function redactPaper(paper) {
  return {
    ...paper,
    sections: (paper.sections ?? []).map((section) => ({
      ...section,
      items: (section.items ?? []).map((item) => redactItem(item)),
    })),
  }
}

export function renderReportMarkdown(report) {
  const lines = []
  const pct = report.max > 0 ? Math.round((report.total / report.max) * 100) : 0
  lines.push(`# ${report.paper_title} · 成绩单`)
  lines.push('')
  lines.push(`> 模拟评分：分数用于定位问题，不等同于 CATTI 官方评分。`)
  lines.push('')
  lines.push(`- 交卷时间：${report.submitted_at}（${report.submit_reason === 'timeout' ? '到点自动交卷' : '手动交卷'}）`)
  lines.push(`- 实际用时：${formatDuration(report.used_seconds)}（暂停 ${report.pause_count} 次，累计 ${formatDuration(report.pause_seconds)}）`)
  lines.push(`- 得分：${report.total} / ${report.max}（${pct}%）`)
  if (report.comprehensive?.max > 0) lines.push(`- 综合：${report.comprehensive.earned} / ${report.comprehensive.max}`)
  if (report.practice?.max > 0) {
    lines.push(`- 实务：${report.practice.graded ? `${report.practice.earned} / ${report.practice.max}` : '未评分（AI 双评在 v1 提供）'}`)
  }
  if (report.pass !== null) lines.push(`- 判定：${report.pass ? '达到 60 分线' : '未达 60 分线'}`)
  lines.push('')
  for (const section of report.sections) {
    lines.push(`## ${section.label}（${section.graded ? `${section.earned} / ${section.max}` : '未评分'}）`)
    if (!section.graded) {
      lines.push('')
      lines.push('本题型的 AI 双评判卷在 v1 提供，本次只保存了作答原文。')
      for (const item of section.items ?? []) {
        lines.push('')
        lines.push(`### ${item.title || item.item_id}`)
        lines.push('')
        lines.push(item.answered ? (item.answer || '（空）') : '_未作答_')
      }
      continue
    }
    lines.push('')
    for (const item of section.items ?? []) {
      const mark = item.disputed ? '争议' : item.correct ? '对' : '错'
      lines.push(`### ${item.item_id} · ${mark} · ${item.earned} / ${item.points}`)
      lines.push('')
      lines.push(`> ${item.stem}`)
      for (const question of item.questions ?? []) {
        if ((item.questions ?? []).length > 1) lines.push(`- ${question.stem}`)
        const correct = question.disputed ? '争议' : question.correct ? '对' : '错'
        lines.push(`  - 你的答案：${question.user_answer || '（空）'}；答案：${question.answer || '—'}；判定：${correct}`)
        if (question.explanation) lines.push(`  - 解析：${question.explanation.replace(/\n/gu, ' ')}`)
        if (question.reason) lines.push(`  - 说明：${question.reason}`)
      }
      lines.push('')
    }
  }
  if ((report.disputed ?? []).length > 0) {
    lines.push('## 待议清单')
    lines.push('')
    lines.push('| 题号 | 题干 | 你的答案 | AI 答案 | 说明 |')
    lines.push('|---|---|---|---|---|')
    for (const item of report.disputed) {
      lines.push(`| ${item.item_id}${item.question_index === null ? '' : `-${item.question_index + 1}`} | ${item.stem} | ${item.user_answer || '（空）'} | ${item.ai_answer} | ${item.reason} |`)
    }
    lines.push('')
  }
  if ((report.notes ?? []).length > 0) {
    lines.push('## 备注')
    lines.push('')
    for (const note of report.notes) lines.push(`- ${note}`)
  }
  return lines.join('\n') + '\n'
}

export function formatDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const rest = total % 60
  if (hours > 0) return `${hours} 小时 ${minutes} 分`
  if (minutes > 0) return `${minutes} 分 ${rest} 秒`
  return `${rest} 秒`
}












