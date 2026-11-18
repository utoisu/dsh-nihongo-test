/**
 * 考试状态机：
 *   ready → running ⇄ paused → submitted → graded
 *
 * 计时一律以 Host 时钟为准：客户端拿到的只是一个 remaining_ms 数字，
 * 页面自己倒计时只负责显示，判定到点由 Host 做。
 * 暂停只停「有效作答时间」，暂停时长单独累计，成绩单上注明。
 */

export const EXAM_STATUS_LABEL = {
  ready: '待开始',
  running: '作答中',
  paused: '已暂停',
  submitted: '已交卷',
  graded: '已出分',
}

export function newExam(paper, now = Date.now()) {
  return {
    id: `E-${now.toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
    paper_id: paper.id,
    paper_title: paper.title,
    status: 'ready',
    duration_ms: Math.max(1, Number(paper.duration_min) || 180) * 60_000,
    active_ms: 0,
    active_started_at: null,
    pause_count: 0,
    pause_ms: 0,
    pause_started_at: null,
    answers: {},
    created_at: new Date(now).toISOString(),
    updated_at: new Date(now).toISOString(),
    submitted_at: null,
    submit_reason: null,
    report_id: null,
  }
}

export function startExam(exam, now = Date.now()) {
  if (exam.status !== 'ready') return exam
  exam.status = 'running'
  exam.active_started_at = now
  exam.updated_at = new Date(now).toISOString()
  return exam
}

export function usedMs(exam, now = Date.now()) {
  let used = Number(exam.active_ms) || 0
  if (exam.status === 'running' && Number.isFinite(exam.active_started_at)) {
    used += Math.max(0, now - exam.active_started_at)
  }
  return used
}

export function remainingMs(exam, now = Date.now()) {
  return Math.max(0, (Number(exam.duration_ms) || 0) - usedMs(exam, now))
}

export function pauseExam(exam, now = Date.now()) {
  if (exam.status !== 'running') return exam
  exam.active_ms = usedMs(exam, now)
  exam.active_started_at = null
  exam.status = 'paused'
  exam.pause_count = (Number(exam.pause_count) || 0) + 1
  exam.pause_started_at = now
  exam.updated_at = new Date(now).toISOString()
  return exam
}

export function resumeExam(exam, now = Date.now()) {
  if (exam.status !== 'paused') return exam
  if (Number.isFinite(exam.pause_started_at)) {
    exam.pause_ms = (Number(exam.pause_ms) || 0) + Math.max(0, now - exam.pause_started_at)
  }
  exam.pause_started_at = null
  exam.status = 'running'
  exam.active_started_at = now
  exam.updated_at = new Date(now).toISOString()
  return exam
}

export function isExpired(exam, now = Date.now()) {
  return exam.status === 'running' && remainingMs(exam, now) <= 0
}

export function submitExam(exam, { reason = 'manual', now = Date.now(), reportId = null } = {}) {
  if (exam.status === 'paused' && Number.isFinite(exam.pause_started_at)) {
    exam.pause_ms = (Number(exam.pause_ms) || 0) + Math.max(0, now - exam.pause_started_at)
    exam.pause_started_at = null
  }
  exam.active_ms = usedMs(exam, now)
  exam.active_started_at = null
  exam.status = reportId ? 'graded' : 'submitted'
  exam.submitted_at = new Date(now).toISOString()
  exam.submit_reason = reason
  exam.updated_at = exam.submitted_at
  if (reportId) exam.report_id = reportId
  return exam
}

export function answerKey(sectionIndex, itemIndex, questionIndex = null) {
  return questionIndex === null || questionIndex === undefined
    ? `${sectionIndex}:${itemIndex}`
    : `${sectionIndex}:${itemIndex}:${questionIndex}`
}

export function setAnswer(exam, key, value) {
  if (exam.status !== 'running') {
    const error = new Error('当前不在作答状态，不能改答案')
    error.code = 'EXAM_NOT_RUNNING'
    throw error
  }
  const text = typeof value === 'string' ? value : ''
  if (text.trim()) exam.answers[key] = text
  else delete exam.answers[key]
  exam.updated_at = new Date().toISOString()
  return exam
}

export function answeredCount(paper, exam) {
  let answered = 0
  let total = 0
  ;(paper.sections ?? []).forEach((section, sectionIndex) => {
    ;(section.items ?? []).forEach((item, itemIndex) => {
      if (section.type === 'reading') {
        ;(item.questions ?? []).forEach((_question, questionIndex) => {
          total += 1
          if (exam.answers[answerKey(sectionIndex, itemIndex, questionIndex)]) answered += 1
        })
      } else {
        total += 1
        if (exam.answers[answerKey(sectionIndex, itemIndex)]) answered += 1
      }
    })
  })
  return { answered, total }
}

export function examView(exam, paper, now = Date.now()) {
  return {
    id: exam.id,
    paper_id: exam.paper_id,
    paper_title: exam.paper_title,
    status: exam.status,
    remaining_ms: remainingMs(exam, now),
    duration_ms: exam.duration_ms,
    used_ms: usedMs(exam, now),
    pause_count: exam.pause_count,
    pause_ms: usedPauseMs(exam, now),
    answers: exam.answers,
    submitted_at: exam.submitted_at,
    submit_reason: exam.submit_reason,
    report_id: exam.report_id,
    server_now: now,
    progress: paper ? answeredCount(paper, exam) : { answered: 0, total: 0 },
  }
}

export function usedPauseMs(exam, now = Date.now()) {
  let paused = Number(exam.pause_ms) || 0
  if (exam.status === 'paused' && Number.isFinite(exam.pause_started_at)) {
    paused += Math.max(0, now - exam.pause_started_at)
  }
  return paused
}
