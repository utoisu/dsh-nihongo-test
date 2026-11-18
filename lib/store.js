/**
 * 落盘层：五库、试卷、成绩、进行中的考试，全是工作区里的普通 JSON。
 *
 * 设计取舍：
 *  - 不建数据库、不建索引。文件小，每次读全量，用 mtime+size 判断磁盘上是否被手改过，
 *    改了就重读——「题库文件可用编辑器改完即生效」这条验收靠它。
 *  - 写一律原子写（util.writeJson），并串行化。
 *  - 试卷存快照（见 paper.js），成绩只引用试卷 id + 分数，不依赖题库当前状态。
 */
import path from 'node:path'
import { promises as fs } from 'node:fs'
import {
  TYPES,
  asArray,
  ensureDir,
  fingerprint,
  nowIso,
  readJson,
  statOrNull,
  writeJson,
} from './util.js'
import { classifyItem, itemFingerprint, looseFingerprint, nextItemId, summarizeItem } from './model.js'

export class CattiStore {
  constructor({ dataDir, corpusPath = '', logger = () => {} } = {}) {
    this.dataDir = dataDir
    this.corpusPath = corpusPath
    this.logger = logger
    this.banks = new Map()
    this.templatesCache = null
    this.startedAt = nowIso()
    this.initError = null
    this.initialized = this.#init()
  }

  ready() {
    return this.initialized
  }

  dirs() {
    return {
      root: this.dataDir,
      banks: path.join(this.dataDir, 'banks'),
      papers: path.join(this.dataDir, 'papers'),
      reports: path.join(this.dataDir, 'reports'),
      runtime: path.join(this.dataDir, 'runtime'),
    }
  }

  async #init() {
    const dirs = this.dirs()
    await ensureDir(dirs.banks)
    await ensureDir(dirs.papers)
    await ensureDir(dirs.reports)
    await ensureDir(dirs.runtime)
    for (const type of TYPES) await this.#loadBank(type)
    await this.#loadTemplates()
  }

  bankFile(type) {
    return path.join(this.dirs().banks, `${type}.json`)
  }

  async #loadBank(type) {
    const file = this.bankFile(type)
    const stat = await statOrNull(file)
    const stored = await readJson(file, null)
    const items = Array.isArray(stored) ? stored : asArray(stored?.items)
    const normalized = items.filter((item) => item && typeof item === 'object' && TYPES.includes(item.type))
    // 老条目缺 exam_kind / year（字段是后加的）：补一次并写回，列表和筛选用得上
    let backfilled = false
    for (const item of normalized) {
      if (item.exam_kind === undefined || item.year === undefined || item.level === undefined) {
        const clue = classifyItem(item)
        item.exam_kind = clue.exam_kind
        item.year = clue.year
        item.level = clue.level
        backfilled = true
      } else if (!item.level) {
        // 早先入库的二笔真题没标级别：来源里写着「二笔」就补上
        const clue = classifyItem(item)
        if (clue.level) {
          item.level = clue.level
          backfilled = true
        }
      }
    }
    this.banks.set(type, {
      items: normalized,
      mtimeMs: stat?.mtimeMs ?? 0,
      size: stat?.size ?? 0,
    })
    if (backfilled) await this.#saveBank(type)
    return normalized
  }

  /** 磁盘被手改（或文件被删）时重读，保证编辑器里改的马上生效。 */
  async bank(type) {
    await this.ready()
    const entry = this.banks.get(type)
    if (!entry) return this.#loadBank(type)
    const stat = await statOrNull(this.bankFile(type))
    if (!stat) {
      if (entry.items.length === 0 && entry.size === 0) return entry.items
      return this.#loadBank(type)
    }
    if (stat.mtimeMs !== entry.mtimeMs || stat.size !== entry.size) {
      return this.#loadBank(type)
    }
    return entry.items
  }

  async #saveBank(type) {
    const entry = this.banks.get(type)
    await writeJson(this.bankFile(type), {
      version: 1,
      type,
      updated_at: nowIso(),
      items: entry.items,
    })
    const stat = await statOrNull(this.bankFile(type))
    entry.mtimeMs = stat?.mtimeMs ?? Date.now()
    entry.size = stat?.size ?? 0
  }

  async allBanks() {
    const out = {}
    for (const type of TYPES) out[type] = await this.bank(type)
    return out
  }

  async stats() {
    const banks = await this.allBanks()
    const types = {}
    for (const type of TYPES) {
      const items = banks[type]
      types[type] = {
        total: items.length,
        active: items.filter((item) => item.status === 'active').length,
        candidate: items.filter((item) => item.status === 'candidate').length,
        needs_human: items.filter((item) => item.status === 'needs_human').length,
        disputed: items.filter((item) => item.status === 'disputed').length,
        rejected: items.filter((item) => item.status === 'rejected').length,
        ai_answer: items.filter((item) => item.answer_src === 'ai_solved' || item.ref_src === 'ai_solved').length,
      }
    }
    const papers = await this.listPapers()
    const reports = await this.listReports()
    return {
      dataDir: this.dataDir,
      corpusPath: this.corpusPath,
      types,
      papers: papers.length,
      reports: reports.length,
      latest_report: reports[0]?.id ?? null,
    }
  }

  // ---------------------------------------------------------- 错题库

  wrongFile() {
    return path.join(this.dataDir, 'wrong.json')
  }

  async wrongList() {
    await this.ready()
    const stored = await readJson(this.wrongFile(), null)
    return Array.isArray(stored?.items) ? stored.items : []
  }

  /** 记一次错题：同一道题多次错只累加次数。 */
  async recordWrong(entries) {
    await this.ready()
    const items = await this.wrongList()
    const index = new Map(items.map((entry) => [`${entry.type}:${entry.id}`, entry]))
    for (const entry of entries) {
      const key = `${entry.type}:${entry.id}`
      const existing = index.get(key)
      if (existing) {
        existing.count = (Number(existing.count) || 1) + 1
        existing.last_at = nowIso()
        existing.last_report = entry.report ?? existing.last_report ?? ''
        existing.last_exam = entry.exam ?? existing.last_exam ?? ''
      } else {
        const fresh = {
          type: entry.type,
          id: entry.id,
          count: 1,
          first_at: nowIso(),
          last_at: nowIso(),
          last_report: entry.report ?? '',
          last_exam: entry.exam ?? '',
        }
        items.push(fresh)
        index.set(key, fresh)
      }
    }
    await writeJson(this.wrongFile(), { version: 1, updated_at: nowIso(), items })
    return items
  }

  async clearWrong(filter = {}) {
    await this.ready()
    const items = await this.wrongList()
    const keep = items.filter((entry) => (filter.type ? entry.type !== filter.type : false) || (filter.id ? entry.id !== filter.id : true))
    await writeJson(this.wrongFile(), { version: 1, updated_at: nowIso(), items: keep })
    return keep
  }

  async listBank(type, options = {}) {
    const items = await this.bank(type)
    const status = options.status && options.status !== 'all' ? String(options.status) : ''
    const difficulty = options.difficulty && options.difficulty !== 'all' ? String(options.difficulty) : ''
    const examKind = options.exam_kind && options.exam_kind !== 'all' ? String(options.exam_kind) : ''
    const level = options.level && options.level !== 'all' ? String(options.level) : ''
    const query = String(options.q ?? '').trim().toLowerCase()
    let filtered = items
    if (status) filtered = filtered.filter((item) => item.status === status)
    if (difficulty) filtered = filtered.filter((item) => item.difficulty === difficulty)
    if (examKind) filtered = filtered.filter((item) => (item.exam_kind ?? '') === examKind)
    if (level) filtered = filtered.filter((item) => (item.level ?? '') === level)
    if (query) {
      filtered = filtered.filter((item) =>
        `${item.id}\n${item.stem ?? ''}\n${item.text ?? ''}\n${item.passage ?? ''}\n${item.source ?? ''}\n${(item.tags ?? []).join(' ')}`
          .toLowerCase()
          .includes(query),
      )
    }    const total = filtered.length
    const offset = Math.max(0, Number(options.offset) || 0)
    const limit = Math.min(500, Math.max(1, Number(options.limit) || 100))
    const page = filtered.slice(offset, offset + limit)
    return {
      total,
      offset,
      limit,
      items: page.map(summarizeItem).reverse(),
    }
  }

  async getItem(type, id) {
    const items = await this.bank(type)
    return items.find((item) => item.id === id) ?? null
  }

  /**
   * 批量入库：按 hash 去重，按题型分配 id。
   * @returns {{added: string[], skipped: Array<{index:number,hash:string,reason:string}>}}
   */
  async addItems(type, items) {
    await this.ready()
    await this.bank(type)
    const entry = this.banks.get(type)
    if (!entry) throw new Error(`题库 ${type} 未加载`)
    const existingHashes = new Set(entry.items.map((item) => item.hash))
    // 宽松指纹：全半角/空白/标点抹平后再比，挡住「同一篇换了排版」的重复
    const existingLoose = new Set(entry.items.map((item) => item.loose_hash || looseFingerprint(item)))
    const ids = new Set(entry.items.map((item) => item.id))
    const added = []
    const skipped = []
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index]
      const loose = looseFingerprint(item)
      if (existingHashes.has(item.hash) || existingLoose.has(loose)) {
        skipped.push({
          index,
          hash: item.hash,
          reason: existingHashes.has(item.hash) ? '库内已有同题（hash 相同）' : '库内已有同题（忽略全半角/空白/标点后相同）',
        })
        continue
      }
      let id = nextItemId(type, ids)
      while (ids.has(id)) id = nextItemId(type, new Set([...ids, id]))
      item.id = id
      item.hash = item.hash || fingerprint({ type, stem: item.stem, text: item.text, passage: item.passage })
      item.loose_hash = loose
      existingHashes.add(item.hash)
      existingLoose.add(loose)
      ids.add(id)
      entry.items.push(item)
      added.push(id)
    }
    if (added.length > 0) await this.#saveBank(type)
    return { added, skipped }
  }

  async setStatus(type, id, status) {
    const entry = this.banks.get(type)
    if (!entry) throw new Error(`题库 ${type} 未加载`)
    const item = entry.items.find((candidate) => candidate.id === id)
    if (!item) throw new Error(`找不到 ${type} 的 ${id}`)
    item.status = status
    item.updated_at = nowIso()
    await this.#saveBank(type)
    return item
  }

  async updateItem(type, id, patch) {
    const entry = this.banks.get(type)
    if (!entry) throw new Error(`题库 ${type} 未加载`)
    const item = entry.items.find((candidate) => candidate.id === id)
    if (!item) throw new Error(`找不到 ${type} 的 ${id}`)
    const allowed = ['stem', 'options', 'answer', 'explanation', 'point', 'passage', 'questions', 'text', 'ref', 'rubric', 'topic', 'difficulty', 'notes', 'tags', 'full_text', 'exam_kind', 'year', 'source', 'title']
    for (const key of allowed) {
      if (patch[key] !== undefined) item[key] = patch[key]
    }
    item.updated_at = nowIso()
    item.hash = itemFingerprint(item)
    item.loose_hash = looseFingerprint(item)
    await this.#saveBank(type)
    return item
  }

  /** 整条替换（人工编辑后用规范化结果覆盖）。 */
  async putItem(type, item) {
    const entry = this.banks.get(type)
    if (!entry) throw new Error(`题库 ${type} 未加载`)
    const index = entry.items.findIndex((candidate) => candidate.id === item.id)
    if (index < 0) throw new Error(`找不到 ${type} 的 ${item.id}`)
    item.updated_at = nowIso()
    item.hash = itemFingerprint(item)
    item.loose_hash = looseFingerprint(item)
    entry.items[index] = item
    await this.#saveBank(type)
    return item
  }

  async removeItem(type, id) {
    const entry = this.banks.get(type)
    const index = entry.items.findIndex((item) => item.id === id)
    if (index < 0) return false
    entry.items.splice(index, 1)
    await this.#saveBank(type)
    return true
  }

  // ---------------------------------------------------------------- 模板

  templatesFile() {
    return path.join(this.dataDir, 'templates.json')
  }

  async #loadTemplates() {
    const stored = await readJson(this.templatesFile(), null)
    this.templatesCache = Array.isArray(stored?.items) ? stored.items : []
    return this.templatesCache
  }

  async templates() {
    await this.ready()
    const stat = await statOrNull(this.templatesFile())
    if (stat && this.templatesStamp !== `${stat.mtimeMs}:${stat.size}`) {
      await this.#loadTemplates()
      this.templatesStamp = `${stat.mtimeMs}:${stat.size}`
    }
    return this.templatesCache
  }

  async saveTemplate(template) {
    const list = await this.templates()
    const index = list.findIndex((entry) => entry.id === template.id)
    if (index >= 0) list[index] = template
    else list.push(template)
    await writeJson(this.templatesFile(), { version: 1, items: list })
    this.templatesCache = list
    return template
  }

  // ---------------------------------------------------------------- 试卷

  paperFile(id) {
    return path.join(this.dirs().papers, `${id}.json`)
  }

  async savePaper(paper) {
    await writeJson(this.paperFile(paper.id), paper)
    return paper
  }

  async getPaper(id) {
    if (!/^[A-Za-z0-9_-]+$/u.test(String(id ?? ''))) return null
    return readJson(this.paperFile(id), null)
  }

  async listPapers() {
    await this.ready()
    const dir = this.dirs().papers
    const names = await fs.readdir(dir).catch(() => [])
    const papers = []
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const paper = await readJson(path.join(dir, name), null)
      if (!paper || !paper.id) continue
      papers.push({
        id: paper.id,
        title: paper.title,
        mode: paper.mode,
        created_at: paper.created_at,
        duration_min: paper.duration_min,
        total_points: paper.total_points,
        year: paper.year ?? null,
        exam_kind: paper.exam_kind ?? '',
        sections: (paper.sections ?? []).map((section) => ({
          type: section.type,
          points: section.points,
          count: section.questions ?? section.items?.length ?? 0,
        })),
      })
    }
    papers.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    return papers
  }

  async removePaper(id) {
    await fs.rm(this.paperFile(id), { force: true })
  }

  // ---------------------------------------------------------------- 成绩

  reportFile(id) {
    return path.join(this.dirs().reports, `${id}.json`)
  }

  async saveReport(report) {
    await writeJson(this.reportFile(report.id), report)
    return report
  }

  async getReport(id) {
    if (!/^[A-Za-z0-9_-]+$/u.test(String(id ?? ''))) return null
    return readJson(this.reportFile(id), null)
  }

  async listReports() {
    await this.ready()
    const dir = this.dirs().reports
    const names = await fs.readdir(dir).catch(() => [])
    const reports = []
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const report = await readJson(path.join(dir, name), null)
      if (!report || !report.id) continue
      const sections = report.sections ?? []
      const graded = sections.filter((section) => section.graded !== false)
      // 新成绩单自带 total/max；老文件按已判分的段重算。
      const earned = Number.isFinite(report.total)
        ? report.total
        : graded.reduce((sum, section) => sum + Number(section.earned ?? 0), 0)
      const max = Number.isFinite(report.max)
        ? report.max
        : graded.reduce((sum, section) => sum + Number(section.max ?? 0), 0)
      reports.push({
        id: report.id,
        paper_id: report.paper_id,
        paper_title: report.paper_title,
        started_at: report.started_at,
        submitted_at: report.submitted_at,
        used_seconds: report.used_seconds,
        pause_count: report.pause_count,
        pause_seconds: report.pause_seconds,
        status: report.status ?? 'graded',
        total: Math.round(earned * 10) / 10,
        max: Math.round(max * 10) / 10,
        all_graded: graded.length === sections.length,
        pass: report.pass ?? null,
        sections: sections.map((section) => ({
          type: section.type,
          earned: section.earned,
          max: section.max,
          graded: section.graded !== false,
        })),
      })
    }
    reports.sort((a, b) => String(b.submitted_at).localeCompare(String(a.submitted_at)))
    return reports
  }

  async removeReport(id) {
    await fs.rm(this.reportFile(id), { force: true })
  }

  // ---------------------------------------------------------------- 进行中的考试

  examsFile() {
    return path.join(this.dirs().runtime, 'exams.json')
  }

  async exams() {
    await this.ready()
    const stored = await readJson(this.examsFile(), null)
    return Array.isArray(stored?.exams) ? stored.exams : []
  }

  async saveExam(exam) {
    const exams = await this.exams()
    const index = exams.findIndex((entry) => entry.id === exam.id)
    if (index >= 0) exams[index] = exam
    else exams.push(exam)
    await writeJson(this.examsFile(), { version: 1, exams })
    return exam
  }

  async removeExam(id) {
    const exams = await this.exams()
    const next = exams.filter((exam) => exam.id !== id)
    await writeJson(this.examsFile(), { version: 1, exams: next })
  }

  // ---------------------------------------------------------------- 审核日志

  async appendAudit(entry) {
    const file = path.join(this.dataDir, 'audit_log.jsonl')
    await ensureDir(this.dataDir)
    await fs.appendFile(file, JSON.stringify({ at: nowIso(), ...entry }) + '\n', 'utf8')
  }
}



