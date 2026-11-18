/**
 * Agent 工具：五个，一个动词一个工具。
 *
 * 每个 execute 都只调 service 的同名方法，和页面走同一条逻辑——
 * 页面上能做的，Agent 能做的，是同一件事。
 */
import { TYPES, TYPE_LABEL } from './util.js'

const OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: true,
    properties: { text: { type: 'string' } },
  },
  render(_args, value) {
    const text = typeof value?.text === 'string' ? value.text : JSON.stringify(value, null, 2)
    return [{ type: 'text', text }]
  },
}

function typeName(type) {
  return TYPE_LABEL[type] ?? type
}

function lines(list) {
  return list.filter(Boolean).join('\n')
}

export function createTools(service) {
  return [
    {
      name: 'catti_bank',
      description:
        'Read or reclassify items in the five CATTI Japanese mock-exam banks (vocabulary, grammar, reading, ja→zh, zh→ja). '
        + 'Actions: stats (counts and quality warnings), list (filter by type/status/query), get (one full item), '
        + 'status (approve, reject, dispute, or send to human review: one id or a list of ids). '
        + 'Items live in the plugin data directory as plain JSON.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['stats', 'list', 'get', 'status', 'update'], description: 'What to do.' },
          type: { type: 'string', enum: TYPES, description: 'Bank to act on. Required for list/get/status/update.' },
          id: { type: 'string', description: 'Item id for get/status/update.' },
          ids: { type: 'array', items: { type: 'string' }, description: 'Several item ids for status.' },
          status: {
            type: 'string',
            enum: ['candidate', 'active', 'disputed', 'rejected', 'needs_human'],
            description: 'Target status for the status action.',
          },
          filter_status: { type: 'string', description: 'Filter for list: one status, or "all".' },
          exam_kind: { type: 'string', enum: ['real', 'mock', 'textbook', 'all'], description: 'Filter for list: real exam, mock, or textbook material.' },
          level: { type: 'string', enum: ['2', '3', 'all'], description: 'Filter for list: CATTI level 2 (二笔) or 3 (三笔).' },
          wrong_only: { type: 'boolean', description: 'Filter for list: only items answered wrong before (错题库).' },
          patch: {
            type: 'object',
            additionalProperties: true,
            description: 'Fields to change for update: stem/options/answer/explanation/point/passage/questions/text/ref/rubric/topic/difficulty/tags/source/notes/exam_kind/year.',
          },
          q: { type: 'string', description: 'Case-insensitive text filter for list.' },
          limit: { type: 'number', description: 'Max rows for list (default 50, max 200).' },
          offset: { type: 'number', description: 'Row offset for list.' },
        },
        required: ['action'],
      },
      output: OUTPUT,
      async execute(args) {
        if (args.action === 'stats') {
          const stats = await service.state()
          const health = await service.health()
          const rows = TYPES.map((type) => {
            const entry = stats.types[type]
            return `${typeName(type)}（${type}）：在库 ${entry.active} / 候选 ${entry.candidate} / 待人工 ${entry.needs_human} / 争议 ${entry.disputed} / 已拒 ${entry.rejected}，共 ${entry.total}`
          })
          const issues = health.issues.map((issue) => `- ${typeName(issue.type)} ${issue.kind}: ${issue.count}（${issue.ids.join(', ')}）`)
          return {
            text: lines([
              `题库目录：${stats.dataDir}`,
              ...rows,
              `AI 答案占比：${Math.round(health.ai_answer_ratio * 100)}%${health.ai_answer_warning ? '（超过 20%，建议复核）' : ''}`,
              issues.length ? '问题：' : '',
              ...issues,
            ]),
            stats,
            health,
          }
        }
        if (args.action === 'list') {
          if (!TYPES.includes(args.type)) throw new Error('type 必须是五种题型之一')
          const limit = Math.min(200, Math.max(1, Number(args.limit) || 50))
          const result = await service.bankList({
            type: args.type,
            status: args.filter_status ?? 'all',
            exam_kind: args.exam_kind ?? 'all',
            wrong_only: args.wrong_only === true,
            level: args.level ?? 'all',
            q: args.q ?? '',
            limit,
            offset: Number(args.offset) || 0,
          })
          const rows = result.items.map((item) => {
            const flag = item.hasAnswer ? '' : ' [无答案]'
            const ai = item.answer_src === 'ai_solved' ? ' [AI答案]' : ''
            const kind = item.exam_kind === 'real' ? '真题' : item.exam_kind === 'mock' ? '模拟' : ''
            return `${item.id} ${item.status} ${kind} ${item.year ?? ''} ${item.difficulty} ${item.source}${flag}${ai} ${item.preview}`
          })
          return {
            text: lines([`${typeName(args.type)} 共 ${result.total} 条，返回 ${rows.length} 条：`, ...rows]).slice(0, 12000),
            result,
          }
        }
        if (args.action === 'update') {
          if (!TYPES.includes(args.type) || !args.id) throw new Error('update 需要 type 与 id')
          if (!args.patch || typeof args.patch !== 'object') throw new Error('update 需要 patch')
          const result = await service.bankUpdate({ type: args.type, id: args.id, patch: args.patch })
          return {
            text: `已更新 ${args.type} ${args.id}（改的字段：${Object.keys(args.patch).join(', ')}）。`,
            result,
          }
        }
        if (args.action === 'get') {
          if (!TYPES.includes(args.type) || !args.id) throw new Error('get 需要 type 与 id')
          const result = await service.bankGet({ type: args.type, id: args.id })
          const item = result.item
          const head = item.type === 'reading'
            ? `${item.id} ${typeName(item.type)} ${item.status} ${item.questions?.length ?? 0} 小题\n${item.passage}`
            : item.type === 'ja2zh' || item.type === 'zh2ja'
              ? `${item.id} ${typeName(item.type)} ${item.status} ${item.chars} 字\n原文：${item.text}\n参考译文：${item.ref || '（无）'}`
              : `${item.id} ${typeName(item.type)} ${item.status}\n题干：${item.stem}\n选项：${(item.options ?? []).map((option, index) => `${String.fromCharCode(65 + index)}. ${option}`).join(' / ')}\n答案：${item.answer || '（无）'}\n解析：${item.explanation || '（无）'}`
          return { text: head, item }
        }
        if (args.action === 'status') {
          if (!TYPES.includes(args.type)) throw new Error('status 需要 type')
          const result = await service.bankStatus({ type: args.type, id: args.id, ids: args.ids, status: args.status })
          return {
            text: `已把 ${result.count} 条 ${typeName(args.type)} 标为「${args.status}」：${result.changed.join(', ') || '（没有改动）'}`,
            result,
          }
        }
        throw new Error(`未知 action：${args.action}`)
      },
    },

    {
      name: 'catti_import',
      description:
        'Turn pasted exam text or the local translation-drill corpus into bank candidates. '
        + 'scan parses text into candidates without writing anything (JSON, or the Markdown question format); '
        + 'commit writes the candidates you pass back, assigning ids and keeping them as candidates; '
        + 'corpus converts the translation-drill items.json segments into ja→zh / zh→ja candidates. '
        + 'Nothing becomes active here: approve with catti_bank status. Textbooks and scanned material must be reviewed first.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['scan', 'commit', 'corpus'], description: 'What to do.' },
          type: { type: 'string', enum: TYPES, description: 'Target bank for scan/commit.' },
          text: { type: 'string', description: 'Raw text to parse for scan.' },
          format: { type: 'string', enum: ['auto', 'json', 'markdown'], description: 'Parser for scan; auto detects JSON by the first character.' },
          source: { type: 'string', description: 'Source label stored on every written item, e.g. "2023-2 真题" or "强化班 p.34".' },
          items: {
            type: 'array',
            description: 'Candidate objects to write for commit; pass the normalized "item" objects returned by scan.',
            items: { type: 'object', additionalProperties: true },
          },
          batch: { type: 'string', description: 'Batch id to group this import; generated when omitted.' },
          kind: { type: 'string', enum: ['S', 'L', 'all'], description: 'Corpus segment kind for corpus: S short passages, L long ones, all both.' },
          limit: { type: 'number', description: 'Max corpus items to convert (default 3000).' },
          path: { type: 'string', description: 'Override corpus items.json path.' },
        },
        required: ['action'],
      },
      output: OUTPUT,
      async execute(args) {
        if (args.action === 'scan') {
          if (!args.text) throw new Error('scan 需要 text')
          const result = await service.importScan({
            type: args.type,
            text: args.text,
            format: args.format ?? 'auto',
            source: args.source ?? '',
          })
          const rows = result.candidates.slice(0, 40).map((candidate) =>
            candidate.ok
              ? `#${candidate.index + 1} ${candidate.item.status === 'needs_human' ? '[待人工]' : '[候选]'} ${candidate.preview}`
              : `#${candidate.index + 1} [解析失败] ${candidate.error}`,
          )
          return {
            text: lines([
              `解析 ${result.total} 条：可入库 ${result.ok}，失败 ${result.failed}，其中待人工 ${result.needs_human}。批次 ${result.batch}。`,
              ...rows,
              result.warnings.length ? `警告：${result.warnings.slice(0, 10).join('；')}` : '',
              '确认无误后用 commit 写库，再用 catti_bank status 由候选人改成 active。',
            ]).slice(0, 12000),
            result,
          }
        }
        if (args.action === 'commit') {
          if (!Array.isArray(args.items) || args.items.length === 0) throw new Error('commit 需要 items')
          const payload = args.items.map((entry) => (entry?.item ? entry.item : entry))
          const result = await service.importCommit({
            type: args.type,
            items: payload,
            batch: args.batch,
            source: args.source ?? '',
          })
          return {
            text: lines([
              `写入 ${typeName(args.type)}：新增 ${result.added.length} 条，重复跳过 ${result.skipped.length} 条，拒绝 ${result.rejected.length} 条。批次 ${result.batch}。`,
              result.added.join(', '),
              result.rejected.length ? `拒绝原因：${result.rejected.map((entry) => entry.error).join('；')}` : '',
            ]),
            result,
          }
        }
        if (args.action === 'corpus') {
          const result = await service.importCorpus({
            kind: args.kind ?? 'S',
            limit: args.limit,
            path: args.path,
          })
          return {
            text: lines([
              `教材语料导入完成（${result.file}）：日译中新增 ${result.ja2zh.added} 条，中译日新增 ${result.zh2ja.added} 条。批次 ${result.batch}。`,
              '都还是「候选」状态；确认后用 catti_bank status 把对应批次改成 active。',
            ]),
            result,
          }
        }
        throw new Error(`未知 action：${args.action}`)
      },
    },

    {
      name: 'catti_paper',
      description:
        'Compose, preview, save, and read mock-exam papers. '
        + 'blueprints lists the CATTI templates with how many items each bank can supply now; '
        + 'compose previews a template or free paper and reports shortfalls instead of padding them; '
        + 'create saves the paper with full item snapshots; list/get read saved papers. '
        + 'Recent items (last five papers and reports) are excluded by default.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['blueprints', 'compose', 'create', 'list', 'get'], description: 'What to do.' },
          mode: { type: 'string', enum: ['template', 'free'], description: 'template uses a CATTI blueprint; free uses the sections you pass.' },
          blueprintId: { type: 'string', description: 'Template id: catti2-comprehensive, catti2-practice, or catti2-full.' },
          sections: {
            type: 'array',
            description: 'Free-mode quotas: one object per bank with type, count, points, and optional chars [min,max].',
            items: { type: 'object', additionalProperties: true },
          },
          title: { type: 'string', description: 'Paper title; defaults to the template title.' },
          duration_min: { type: 'number', description: 'Exam duration in minutes.' },
          seed: { type: 'number', description: 'Same seed reproduces the same selection between compose and create.' },
          constraints: {
            type: 'object',
            description: 'Source/difficulty/topic filter: { source: "real"|"mock"|"textbook"|"manual", difficulty: ["L1","L2","L3"], topic: ["经济", …] }.',
            additionalProperties: true,
          },
          excludeRecent: { type: 'boolean', description: 'Exclude items used by the last five papers/reports (default true).' },
          allowShort: { type: 'boolean', description: 'Save even when a quota cannot be filled (default false).' },
          paperId: { type: 'string', description: 'Paper id for get.' },
        },
        required: ['action'],
      },
      output: OUTPUT,
      async execute(args) {
        if (args.action === 'blueprints') {
          const list = await service.blueprints()
          const rows = list.map((blueprint) => {
            const sections = blueprint.sections
              .map((section) => `${typeName(section.type)} ${section.count}${typeName(section.type) === '阅读理解' ? '题' : ''}（可抽 ${section.available}）`)
              .join(' + ')
            return `${blueprint.id} · ${blueprint.title}（${blueprint.duration_min} 分钟）：${sections}`
          })
          return { text: lines(rows), blueprints: list }
        }
        if (args.action === 'compose') {
          const result = await service.paperCompose({
            mode: args.mode ?? 'template',
            blueprintId: args.blueprintId,
            sections: args.sections,
            title: args.title,
            duration_min: args.duration_min,
            seed: args.seed,
            constraints: args.constraints,
            excludeRecent: args.excludeRecent,
          })
          const rows = result.preview.map((section) =>
            `${section.label}：${section.count} 题 / ${section.chars || 0} 字，${section.points} 分（每题 ${section.per_question} 分）${section.items.length ? '\n  ' + section.items.slice(0, 8).map((item) => `${item.id} ${item.preview}`).join('\n  ') : ''}`,
          )
          const shortfalls = result.shortfalls.map((shortfall) => `不足：${typeName(shortfall.type)} 需要 ${shortfall.need}，只有 ${shortfall.have}（${shortfall.reason}）`)
          return {
            text: lines([`预览：${result.blueprint.title}，${result.duration_min} 分钟，总分 ${result.total_points}。seed=${result.seed}`, ...rows, ...shortfalls, ...result.warnings]).slice(0, 12000),
            result,
          }
        }
        if (args.action === 'create') {
          const result = await service.paperCreate({
            mode: args.mode ?? 'template',
            blueprintId: args.blueprintId,
            sections: args.sections,
            title: args.title,
            duration_min: args.duration_min,
            seed: args.seed,
            constraints: args.constraints,
            excludeRecent: args.excludeRecent,
            allowShort: args.allowShort,
          })
          const paper = result.paper
          return {
            text: lines([
              `已建卷 ${paper.id}「${paper.title}」：${paper.duration_min} 分钟，总分 ${paper.total_points}。`,
              ...paper.sections.map((section) => `${section.label}：${section.questions ?? section.items.length} 题，${section.points} 分`),
              '用 catti_exam start 开始考试，或在页面「考试」里开始。',
            ]),
            result,
          }
        }
        if (args.action === 'list') {
          const result = await service.paperList()
          const rows = result.papers.map((paper) => `${paper.id} ${paper.title}（${paper.duration_min} 分钟，${paper.sections.length} 段，${paper.created_at}）`)
          return { text: lines([`共 ${rows.length} 份试卷：`, ...rows]), result }
        }
        if (args.action === 'get') {
          const result = await service.paperGet({ paperId: args.paperId })
          const paper = result.paper
          return {
            text: lines([
              `${paper.id}「${paper.title}」，${paper.duration_min} 分钟，总分 ${paper.total_points}${result.redacted ? '（答案已脱敏：这场考试还在进行）' : ''}`,
              ...paper.sections.map((section) => `${section.label}：${section.questions ?? section.items.length} 题，${section.points} 分`),
            ]),
            result,
          }
        }
        throw new Error(`未知 action：${args.action}`)
      },
    },

    {
      name: 'catti_exam',
      description:
        'Drive one timed exam on the server clock: start (opens or resumes the paper), state (remaining time, progress, the redacted paper), '
        + 'pause, resume (unlimited), submit (grades objective sections and writes the report). '
        + 'A running exam auto-submits when its remaining time reaches zero; only one exam may be active at a time.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['start', 'state', 'pause', 'resume', 'submit'], description: 'What to do.' },
          paperId: { type: 'string', description: 'Paper to start.' },
          examId: { type: 'string', description: 'Exam id; omitted means the current active exam.' },
        },
        required: ['action'],
      },
      output: OUTPUT,
      async execute(args) {
        if (args.action === 'start') {
          const result = await service.examStart({ paperId: args.paperId })
          return {
            text: lines([
              `考试已开始：${result.exam.paper_title}（${result.exam.id}），剩余 ${Math.round(result.exam.remaining_ms / 60000)} 分钟。`,
              '作答在页面「考试」标签里进行；也可以先用 catti_exam state 拿到题目与当前进度。',
            ]),
            result,
          }
        }
        if (args.action === 'state') {
          const result = await service.examState({ examId: args.examId })
          if (!result.exam) return { text: '当前没有进行中的考试。', result }
          const exam = result.exam
          return {
            text: lines([
              `${exam.paper_title}（${exam.status}），剩余 ${Math.floor(exam.remaining_ms / 60000)} 分 ${Math.round((exam.remaining_ms % 60000) / 1000)} 秒，已答 ${exam.progress.answered}/${exam.progress.total}。`,
              result.paper ? `题段：${result.paper.sections.map((section) => `${section.label} ${section.items.length}`).join(' / ')}` : '',
            ]),
            result,
          }
        }
        if (args.action === 'pause') {
          const result = await service.examPause({ examId: args.examId })
          return { text: `已暂停（第 ${result.exam.pause_count} 次），剩余 ${Math.round(result.exam.remaining_ms / 1000)} 秒。`, result }
        }
        if (args.action === 'resume') {
          const result = await service.examResume({ examId: args.examId })
          return { text: `已恢复，剩余 ${Math.round(result.exam.remaining_ms / 1000)} 秒。`, result }
        }
        if (args.action === 'submit') {
          const result = await service.examSubmit({ examId: args.examId })
          const report = result.report
          return {
            text: lines([
              report ? `已交卷：${report.paper_title}，成绩单 ${report.id}。` : '已交卷，但没有生成成绩单。',
              report?.status === 'pending_review'
                ? '客观题已判；实务段待评（pending_review）。用 catti_grade 起双评写回后才出总分与合否。'
                : report ? `总分 ${report.total} / ${report.max}（综合 ${report.comprehensive.earned} / ${report.comprehensive.max}）。` : '',
              report ? `用时 ${Math.round(report.used_seconds / 60)} 分钟，暂停 ${report.pause_count} 次。` : '',
            ]),
            result,
          }
        }
        throw new Error(`未知 action：${args.action}`)
      },
    },

    {
      name: 'catti_grade',
      description:
        'Grade the practice (translation) sections of a submitted report. Two paths share the same review records: start runs the reviewers inside the plugin '
        + '(two model calls per section, a third when the gap exceeds the threshold) and is what the page button uses; material plus commit is the session path, '
        + 'where the main session runs reviewers as subagents and writes their scores back. '
        + 'Actions: pending (reports waiting for review), start (launch the in-plugin grading job), status (poll that job), material (each section\'s original, '
        + 'the candidate translation, any official reference, the rubric, and the exact JSON contract for a reviewer), commit (write reviewer scores back; A and B '
        + 'within the threshold average, otherwise a third review C is required and all three average). Commit flips the report from pending_review to graded.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['pending', 'material', 'commit', 'start', 'status'], description: 'What to do.' },
          reportId: { type: 'string', description: 'Report id for material/commit/start/status.' },
          threshold: { type: 'number', description: 'Allowed gap between two reviews before a third is required (default 3 points).' },
          reviews: {
            type: 'array',
            description: 'One object per reviewer per section: { section_index, reviewer: "A"|"B"|"C", score, breakdown?, points?, errors? }.',
            items: { type: 'object', additionalProperties: true },
          },
        },
        required: ['action'],
      },
      output: OUTPUT,
      async execute(args) {
        if (args.action === 'pending') {
          const result = await service.gradePending()
          if (result.pending.length === 0) return { text: '没有待判分的成绩单。', result }
          const rows = result.pending.map((entry) =>
            `${entry.report_id} ${entry.paper_title}：待评 ${entry.pending_sections.map((section) => `${section.label}（第 ${section.section_index} 段，${section.max} 分）`).join('、')}`,
          )
          return {
            text: lines([
              '以下成绩单在等实务评分（客观题已判，状态 pending_review）：',
              ...rows,
              '下一步：catti_grade material reportId=<id> 取材料 → 起两个子智能体各写一份 JSON → catti_grade commit 写回。',
            ]),
            result,
          }
        }
        if (args.action === 'start') {
          const result = await service.gradeStart({ reportId: args.reportId, threshold: args.threshold })
          return { text: `批改任务已启动（${result.job.reportId}）：${result.job.state}`, result }
        }
        if (args.action === 'status') {
          const result = await service.gradeStatus({ reportId: args.reportId })
          const job = result.job
          return {
            text: job ? `批改状态：${job.state} · ${job.progress}${job.error ? ` · ${job.error}` : ''}` : '这个成绩单没有批改任务',
            result,
          }
        }
        if (args.action === 'material') {
          const result = await service.gradeMaterial({ reportId: args.reportId })
          const rows = result.sections.map((section) => {
            const items = section.items.map((item) =>
              `  · ${item.item_id}（${item.chars} 字${item.answered ? '' : '，未作答'}）${item.reference ? '，有官方参考译文' : ''}`)
            return `第 ${section.section_index} 段「${section.label}」满分 ${section.max}：\n${items.join('\n')}`
          })
          return {
            text: lines([
              `${result.paper_title}（${result.report_id}）待评：`,
              ...rows,
              '材料（原文/译文/参考/采分点）与评审契约在结构化结果里；阈值 ' + result.threshold + ' 分。',
              '让子智能体只输出契约里的 JSON；两份都回来后用 commit 写回。',
            ]),
            result,
          }
        }
        if (args.action === 'commit') {
          const result = await service.gradeCommit({
            reportId: args.reportId,
            reviews: args.reviews,
            threshold: args.threshold,
          })
          const report = result.report
          return {
            text: lines([
              `已写回评分：${report.paper_title}（${report.id}）状态 ${report.status}。`,
              `总分 ${report.total} / ${report.max}${report.pass === null ? '' : report.pass ? '，达线' : '，未达线'}。`,
              ...report.sections
                .filter((section) => section.review)
                .map((section) => `${section.label}：${section.earned} / ${section.max}（${section.review.method === 'mean3' ? '三评均值' : '双评均值'}，A/B 差 ${section.review.diff}）`),
            ]),
            result,
          }
        }
        throw new Error(`未知 action：${args.action}`)
      },
    },

    {
      name: 'catti_report',
      description:
        'Read or export a graded report. list shows past reports with totals; get returns one report with per-question verdicts, '
        + 'disputed answers, pause statistics, and the practice-section originals; export writes the report as Markdown next to the data. '
        + 'Scores are simulated: use them to locate weaknesses, not as official CATTI results.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'get', 'export'], description: 'What to do.' },
          reportId: { type: 'string', description: 'Report id for get/export.' },
        },
        required: ['action'],
      },
      output: OUTPUT,
      async execute(args) {
        if (args.action === 'list') {
          const result = await service.reportList()
          const rows = result.reports.map((report) =>
            `${report.id} ${report.paper_title}：${report.status === 'pending_review' ? '待判分' : `${report.total} / ${report.max}${report.pass === null ? '' : report.pass ? ' 达线' : ' 未达线'}`}，${report.submitted_at}${report.all_graded ? '' : '（含未评分段）'}`,
          )
          return { text: lines([`共 ${rows.length} 份成绩单：`, ...rows]), result }
        }
        if (args.action === 'get') {
          const result = await service.reportGet({ reportId: args.reportId })
          const report = result.report
          const sectionRows = report.sections.map((section) =>
            `${section.label}：${section.graded ? `${section.earned} / ${section.max}` : '待判分'}${section.disputed_points ? `（待议 ${section.disputed_points} 分）` : ''}`,
          )
          return {
            text: lines([
              `${report.paper_title}（${report.id}）：${report.status === 'pending_review' ? '待判分' : `${report.total} / ${report.max}`}`,
              ...sectionRows,
              `用时 ${Math.round(report.used_seconds / 60)} 分钟，暂停 ${report.pause_count} 次共 ${Math.round(report.pause_seconds / 60)} 分钟。`,
              report.disputed.length ? `待议 ${report.disputed.length} 题。` : '',
              report.status === 'pending_review' ? '实务段未评：用 catti_grade material/commit 写回双评。' : '',
              ...(report.notes ?? []).map((note) => `- ${note}`),
            ]),
            result,
          }
        }
        if (args.action === 'export') {
          const result = await service.reportExport({ reportId: args.reportId })
          return { text: `已导出：${result.file}`, result: { file: result.file } }
        }
        throw new Error(`未知 action：${args.action}`)
      },
    },
  ]
}


