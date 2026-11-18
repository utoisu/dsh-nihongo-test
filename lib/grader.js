/**
 * 判分。
 *
 * 综合（词汇/语法/阅读）客观题当场判；实务段在 MVP 里只保存作答、不判分
 * （AI 双评在 v1），成绩单上明确写「未评分」，不拿 0 分糊弄。
 *
 * 争议规则（需求书 §7）：
 *  - 官方答案：正常判。
 *  - AI 补的答案、confidence=high：正常判（即「用户错、AI 对 → 判错」）。
 *  - AI 补的答案、confidence=mid：答对了给分，答错了标 disputed 不扣分。
 *  - AI 补的答案、confidence=low：整题进待议，不参与判分。
 * 争议题与未判分的分值在成绩单上单列，绝不悄悄折算。
 */
import { PRACTICE_TYPES, TYPE_LABEL, round1 } from './util.js'
import { answerKey, examView, submitExam, usedMs, usedPauseMs } from './exam.js'

function letterOf(answer) {
  return String(answer ?? '').trim().toUpperCase()
}

function judgeObjectiveQuestion(item, question, userAnswer) {
  const official = letterOf(question.answer)
  const confidence = item.confidence ?? 'high'
  const answerSrc = question.answer_src ?? item.answer_src ?? (official ? 'official' : 'none')
  const answered = Boolean(userAnswer)
  if (!official) {
    return { outcome: 'unscored', correct: null, disputed: true, reason: '题目没有答案' }
  }
  if (!answered) return { outcome: 'wrong', correct: false, disputed: false, reason: '' }
  if (answerSrc === 'ai_solved' && confidence === 'low') {
    return { outcome: 'disputed', correct: null, disputed: true, reason: 'AI 补的答案，置信度低，不参与判分' }
  }
  if (letterOf(userAnswer) === official) {
    return { outcome: 'correct', correct: true, disputed: false, reason: '' }
  }
  if (answerSrc === 'ai_solved' && confidence === 'mid') {
    return { outcome: 'disputed', correct: null, disputed: true, reason: 'AI 补的答案、置信度中，与你的答案不一致，暂不判分' }
  }
  return { outcome: 'wrong', correct: false, disputed: false, reason: '' }
}

function previewOf(item) {
  const text = item.stem ?? item.text ?? item.passage ?? ''
  const clean = String(text).replace(/\s+/gu, ' ').trim()
  return clean.length > 60 ? clean.slice(0, 60) + '…' : clean
}

/**
 * @param {{paper: object, exam: object, now?: number}} input
 * @returns 成绩单对象（同时把 exam 推到 graded）
 */
export function buildReport({ paper, exam, now = Date.now() }) {
  const sections = []
  const disputed = []
  let objectiveItems = 0
  let aiAnsweredItems = 0
  let totalEarned = 0
  let totalMax = 0
  let ungradedNote = false

  ;(paper.sections ?? []).forEach((section, sectionIndex) => {
    const questionsPerItem = (item) => (section.type === 'reading' ? (item.questions ?? []).length : 1)
    const totalQuestions = (section.items ?? []).reduce((sum, item) => sum + questionsPerItem(item), 0)
    const perPoint = totalQuestions > 0 ? section.points / totalQuestions : 0

    if (PRACTICE_TYPES.has(section.type)) {
      ungradedNote = true
      const answeredPractice = (section.items ?? []).filter((_item, itemIndex) => exam.answers[answerKey(sectionIndex, itemIndex)]).length
      sections.push({
        type: section.type,
        label: section.label ?? TYPE_LABEL[section.type],
        points: section.points,
        graded: false,
        earned: null,
        max: section.points,
        answered: answeredPractice,
        answered_questions: answeredPractice,
        total_questions: (section.items ?? []).length,
        total_items: (section.items ?? []).length,
        items: (section.items ?? []).map((item, itemIndex) => ({
          item_id: item.id,
          title: item.title || previewOf(item),
          text: item.text ?? '',
          chars: item.chars ?? 0,
          answered: Boolean(exam.answers[answerKey(sectionIndex, itemIndex)]),
          answer: exam.answers[answerKey(sectionIndex, itemIndex)] ?? '',
          ref: item.ref ?? '',
          ref_src: item.ref_src ?? 'none',
          rubric: item.rubric ?? [],
          points: null,
        })),
        note: '待判分：客观题已判，这一段等 catti_grade 写回双评。',
        review: null,
      })
      return
    }

    let earned = 0
    let disputedPoints = 0
    const items = []

    ;(section.items ?? []).forEach((item, itemIndex) => {
      const questions = section.type === 'reading'
        ? (item.questions ?? []).map((question, questionIndex) => ({ question, questionIndex }))
        : [{ question: { stem: item.stem, options: item.options, answer: item.answer }, questionIndex: null }]

      const itemRecord = {
        item_id: item.id,
        stem: previewOf(item),
        passage: section.type === 'reading' ? previewOf({ text: item.passage }) : '',
        answer_src: item.answer_src ?? 'official',
        confidence: item.confidence ?? 'high',
        points: 0,
        earned: 0,
        answered: false,
        correct: true,
        disputed: false,
        questions: [],
      }

      for (const { question, questionIndex } of questions) {
        const key = answerKey(sectionIndex, itemIndex, questionIndex)
        const userAnswer = exam.answers[key] ?? ''
        const judged = judgeObjectiveQuestion(item, question, userAnswer)
        objectiveItems += 1
        if (item.answer_src === 'ai_solved') aiAnsweredItems += 1
        if (userAnswer) itemRecord.answered = true

        let gained = 0
        if (judged.outcome === 'correct') gained = perPoint
        if (judged.outcome === 'wrong') itemRecord.correct = false
        if (judged.disputed) disputedPoints += perPoint
        if (judged.outcome === 'disputed' || judged.outcome === 'unscored') itemRecord.disputed = true

        earned += gained
        itemRecord.points = round1(itemRecord.points + perPoint)
        itemRecord.earned = round1(itemRecord.earned + gained)
        itemRecord.questions.push({
          stem: question.stem ?? '',
          options: question.options ?? [],
          user_answer: userAnswer,
          answer: question.answer ?? '',
          correct: judged.correct,
          disputed: judged.disputed,
          reason: judged.reason,
          explanation: question.explanation ?? item.explanation ?? '',
        })

        if (judged.disputed) {
          disputed.push({
            section_type: section.type,
            section_label: section.label ?? TYPE_LABEL[section.type],
            item_id: item.id,
            question_index: questionIndex,
            stem: previewOf(question),
            user_answer: userAnswer,
            ai_answer: question.answer ?? '',
            answer_src: item.answer_src ?? 'official',
            confidence: item.confidence ?? 'high',
            reason: judged.reason,
            points: round1(perPoint),
          })
        }
      }

      itemRecord.disputed = itemRecord.questions.some((question) => question.disputed)
      itemRecord.correct = itemRecord.disputed
        ? null
        : itemRecord.answered && itemRecord.questions.every((question) => question.correct === true)
      items.push(itemRecord)
    })

    totalEarned += earned
    const answeredQuestions = items.reduce(
      (sum, item) => sum + item.questions.filter((question) => question.user_answer).length,
      0,
    )
    const totalQuestionsInSection = items.reduce((sum, item) => sum + item.questions.length, 0)
    sections.push({
      type: section.type,
      label: section.label ?? TYPE_LABEL[section.type],
      points: section.points,
      graded: true,
      earned: round1(earned),
      max: section.points,
      disputed_points: round1(disputedPoints),
      answered: items.filter((item) => item.answered).length,
      answered_questions: answeredQuestions,
      total_questions: totalQuestionsInSection,
      total_items: items.length,
      items,
    })
  })

  const usedSeconds = Math.round(usedMs(exam, now) / 1000)
  const pauseSeconds = Math.round(usedPauseMs(exam, now) / 1000)
  const notes = []
  notes.push('模拟评分：分数用于定位问题，不等同于 CATTI 官方评分。')
  if (ungradedNote) {
    notes.push('实务段尚未判分：在本会话里用 catti_grade 跑双评并把结果写回，状态会从 pending_review 转 graded。')
  }
  if (disputed.length > 0) notes.push(`有 ${disputed.length} 题（合计 ${round1(disputed.reduce((sum, item) => sum + item.points, 0))} 分）因答案存疑暂不判分。`)
  const aiRatio = objectiveItems > 0 ? aiAnsweredItems / objectiveItems : 0
  if (aiRatio > 0.2) notes.push(`本卷 AI 答案题占比 ${Math.round(aiRatio * 100)}%，超过 20%，建议先补官方答案或复核题库。`)
  const hasObjective = sections.some((section) => !PRACTICE_TYPES.has(section.type))
  if (hasObjective) {
    const objectiveMax = sections
      .filter((section) => !PRACTICE_TYPES.has(section.type))
      .reduce((sum, section) => sum + section.max, 0)
    if (objectiveMax > 0 && objectiveMax !== 100) {
      notes.push(`本卷综合满分 ${objectiveMax} 分，达线按 60%（${Math.round(objectiveMax * 0.6)} 分）折算。`)
    }
  }

  const report = {
    id: `R-${now.toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
    paper_id: paper.id,
    paper_title: paper.title,
    started_at: exam.created_at,
    submitted_at: new Date(now).toISOString(),
    used_seconds: usedSeconds,
    pause_count: Number(exam.pause_count) || 0,
    pause_seconds: pauseSeconds,
    submit_reason: exam.submit_reason ?? 'manual',
    sections: sections.map((section) => ({
      ...section,
      earned: section.earned === null ? null : round1(section.earned),
    })),
    ai_answer_ratio: round1(aiRatio * 100) / 100,
    disputed,
    notes,
    created_at: new Date(now).toISOString(),
  }

  finalizeReport(report)

  submitExam(exam, { reason: exam.submit_reason ?? 'manual', now, reportId: report.id })
  report.exam = examView(exam, paper, now)
  return report
}

/**
 * 从 sections 重算总分/合否/状态。交卷时算一次，双评写回后再算一次。
 *
 * 状态：
 *   pending_review —— 客观题已判，实务段还没评（等主会话把 catti_grade 的 review[] 写回）
 *   graded         —— 所有段都有分
 */
export function finalizeReport(report) {
  const objective = report.sections.filter((section) => !PRACTICE_TYPES.has(section.type) && section.graded !== false)
  const practice = report.sections.filter((section) => PRACTICE_TYPES.has(section.type))
  const practiceGraded = practice.filter((section) => section.graded === true)

  const comprehensiveEarned = round1(objective.reduce((sum, section) => sum + Number(section.earned ?? 0), 0))
  const comprehensiveMax = objective.reduce((sum, section) => sum + Number(section.max ?? 0), 0)
  const practiceEarned = round1(practiceGraded.reduce((sum, section) => sum + Number(section.earned ?? 0), 0))
  const practiceMax = practice.reduce((sum, section) => sum + Number(section.max ?? 0), 0)

  report.comprehensive = { earned: comprehensiveEarned, max: comprehensiveMax }
  report.practice = {
    earned: practiceEarned,
    max: practiceMax,
    graded: practice.length > 0 && practiceGraded.length === practice.length,
    graded_sections: practiceGraded.length,
    total_sections: practice.length,
  }
  report.status = practice.length > 0 && practiceGraded.length < practice.length ? 'pending_review' : 'graded'
  // 待判分时总分只算已判的客观题；实务段的分不进总分，等写回后再加。
  const practicePending = report.status === 'pending_review'
  report.total = round1(comprehensiveEarned + (practicePending ? 0 : practiceEarned))
  report.max = round1(comprehensiveMax + (practicePending ? 0 : practiceMax))
  report.practice.pending = practicePending

  let pass = null
  if (report.practice.graded) {
    const comprehensivePass = comprehensiveMax > 0 ? comprehensiveEarned / comprehensiveMax >= 0.6 : false
    const practicePass = practiceMax > 0 ? practiceEarned / practiceMax >= 0.6 : false
    if (comprehensiveMax > 0 && practiceMax > 0) pass = comprehensivePass && practicePass
    else if (comprehensiveMax > 0) pass = comprehensivePass
    else if (practiceMax > 0) pass = practicePass
  } else if (practice.length === 0 && comprehensiveMax > 0) {
    pass = comprehensiveEarned / comprehensiveMax >= 0.6
  }
  report.pass = pass
  return report
}

/**
 * 把双评/三评写回成绩单。
 *
 * @param {object} report
 * @param {Array<{section_index:number, reviewer:'A'|'B'|'C', score:number}>} reviews
 * @param {{threshold?: number, source?: string}} options
 */
export function applyReviews(report, reviews, { threshold = 3, source = '' } = {}) {
  const bySection = new Map()
  for (const review of reviews) {
    const index = Number(review.section_index)
    if (!Number.isInteger(index)) {
      const error = new Error('section_index 必须是整数')
      error.code = 'BAD_REVIEW'
      throw error
    }
    if (!bySection.has(index)) bySection.set(index, [])
    bySection.get(index).push({
      reviewer: String(review.reviewer ?? '').toUpperCase() || `R${bySection.get(index).length + 1}`,
      score: Number(review.score),
      breakdown: review.breakdown ?? null,
      points: Array.isArray(review.points) ? review.points : [],
      errors: Array.isArray(review.errors) ? review.errors : [],
      note: String(review.note ?? ''),
    })
  }

  const missing = []
  for (const [index, entries] of bySection) {
    const section = report.sections[index]
    if (!section) continue
    if (!PRACTICE_TYPES.has(section.type)) continue
    const valid = entries.filter((entry) => Number.isFinite(entry.score))
    if (valid.length === 0) continue
    valid.sort((a, b) => a.reviewer.localeCompare(b.reviewer))
    const a = valid.find((entry) => entry.reviewer === 'A') ?? valid[0]
    const b = valid.find((entry) => entry.reviewer === 'B') ?? valid[1]
    if (!b) {
      missing.push({ index, label: section.label, need: 'A 与 B 两份评分' })
      continue
    }
    const diff = Math.abs(a.score - b.score)
    const third = valid.find((entry) => entry.reviewer === 'C') ?? valid[2]
    let score
    let method
    if (diff <= threshold) {
      score = (a.score + b.score) / 2
      method = 'mean2'
    } else if (third) {
      score = (a.score + b.score + third.score) / 3
      method = 'mean3'
    } else {
      missing.push({
        index,
        label: section.label,
        need: `A、B 相差 ${round1(diff)} 分，超过阈值 ${threshold}，还需要第三评（reviewer: "C"）`,
      })
      continue
    }
    const capped = Math.max(0, Math.min(Number(section.max) || 0, score))
    section.graded = true
    section.earned = round1(capped)
    section.review = {
      method,
      threshold,
      diff: round1(diff),
      reviewers: [a, b, ...(third && method === 'mean3' ? [third] : [])],
      raw_score: round1(score),
      committed_at: new Date().toISOString(),
      source,
    }
    report.review = (report.review ?? []).filter((entry) => entry.section_index !== index)
    report.review.push({
      section_index: index,
      section_type: section.type,
      label: section.label,
      max: section.max,
      score: round1(capped),
      method,
      threshold,
      diff: round1(diff),
      reviewers: section.review.reviewers,
      committed_at: section.review.committed_at,
    })
  }

  if (missing.length > 0) {
    const error = new Error(
      '评分还不齐：' + missing.map((entry) => `第 ${entry.index} 段「${entry.label}」${entry.need}`).join('；'),
    )
    error.code = 'NEED_REVIEW'
    error.missing = missing
    throw error
  }

  finalizeReport(report)
  const cleaned = (report.notes ?? []).filter((note) => !note.includes('尚未判分') && !note.includes('仍有待判分的段'))
  report.notes = cleaned
  if (report.status === 'graded') {
    const methods = (report.review ?? []).map((entry) => `${entry.label} ${entry.method === 'mean3' ? '三评' : '双评'}均值`).join('；')
    report.notes.push(`实务段已判：${methods}（阈值 ${threshold} 分）。`)
  } else {
    const pending = report.sections
      .map((section, index) => ({ section, index }))
      .filter((entry) => PRACTICE_TYPES.has(entry.section.type) && entry.section.graded !== true)
      .map((entry) => `第 ${entry.index} 段「${entry.section.label}」`)
    report.notes.push('仍有待判分的段：' + pending.join('、') + '。全部写回后才出总分与合否。')
  }
  return report
}
