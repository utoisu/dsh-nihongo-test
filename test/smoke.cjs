/**
 * 无界面的功能自测：直接用 node 跑 service，不经过 DSH。
 * 覆盖：五库导入 → 组卷 → 考试（暂停/恢复/交卷）→ 判分 → 成绩导出 → 手改文件生效。
 */
const path = require('node:path')
const fs = require('node:fs')
const { pathToFileURL } = require('node:url')

const root = process.argv[2]
const dataDir = process.argv[3]
const outFile = process.argv[4]
const lines = []
let failures = 0

function ok(name, extra) {
  lines.push(`PASS ${name}${extra ? ' — ' + extra : ''}`)
}
function bad(name, error) {
  failures += 1
  lines.push(`FAIL ${name} — ${error && error.stack ? error.stack.split('\n').slice(0, 4).join(' | ') : error}`)
}
function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const GRAMMAR = Array.from({ length: 45 }, (_, index) => ({
  stem: `语法题 ${index + 1}：彼は忙しい（　　）、毎日ジョギングを続けている。`,
  options: ['にもかかわらず', 'ながらも', 'ものの', 'くせに'],
  answer: ['A', 'B', 'C', 'D'][index % 4],
  explanation: '测试解析 ' + (index + 1),
  point: '～にもかかわらず',
  difficulty: ['L1', 'L2', 'L3'][index % 3],
  topic: ['经济', '政法', '社科'][index % 3],
}))

const VOCAB_MD = Array.from({ length: 12 }, (_, index) => [
  `${index + 1}. 词汇题 ${index + 1}：「深刻」の読み方は。`,
  'A. しんこく',
  'B. ふかこく',
  'C. しんきょく',
  'D. ふかきょく',
  `答案：${['A', 'B', 'C', 'D'][index % 4]}`,
  `解析：第 ${index + 1} 题的解析文字，不该进题干。`,
].join('\n')).join('\n\n')

const READING_QUESTIONS = Array.from({ length: 5 }, (_, qIndex) => [
  `${qIndex + 1}. 文章の内容に合うものはどれか。`,
  'A. 選択肢 A',
  'B. 選択肢 B',
  'C. 選択肢 C',
  'D. 選択肢 D',
  `答案：${['A', 'B', 'C', 'D'][qIndex % 4]}`,
  `解析：第 ${qIndex + 1} 问解析。`,
].join('\n')).join('\n\n')

const READING_MD = Array.from({ length: 5 }, (_, index) => [
  '【文章】',
  `これは読み物 ${index + 1} の本文である。`.repeat(12),
  '【题目】',
  READING_QUESTIONS,
].join('\n')).join('\n\n---\n\n')

function jaText(index, length) {
  const base = `日本の経済は${index}年、少子高齢化と人手不足という構造的な問題に直面しながらも、輸出企業の業績回復と訪日客の増加に支えられ、緩やかな回復基調をたどった。`
  return base.repeat(Math.ceil(length / base.length)).slice(0, length)
}

const JA2ZH_MD = Array.from({ length: 6 }, (_, index) => [
  `### 第 ${index + 1} 段`,
  jaText(index, 520),
  `参考译文：这是第 ${index + 1} 段的中文参考译文。`,
].join('\n')).join('\n\n---\n\n')

const ZH2JA_MD = Array.from({ length: 6 }, (_, index) => [
  `### 第 ${index + 1} 段`,
  `这是中文原文第 ${index} 段。中国经济在结构调整中保持韧性，消费与出口共同支撑增长。`.repeat(4).slice(0, 260),
  `参考译文：これは ${index + 1} 段落目の日本語訳です。`,
].join('\n')).join('\n\n---\n\n')

async function main() {
  const util = await import(pathToFileURL(path.join(root, 'lib/util.js')).href)
  const { CattiStore } = await import(pathToFileURL(path.join(root, 'lib/store.js')).href)
  const { CattiService } = await import(pathToFileURL(path.join(root, 'lib/service.js')).href)
  const { normalizeItem } = await import(pathToFileURL(path.join(root, 'lib/model.js')).href)

  fs.rmSync(dataDir, { recursive: true, force: true })
  const store = new CattiStore({ dataDir, logger: (message) => lines.push('LOG  ' + message) })
  const service = new CattiService({ store, logger: (message) => lines.push('LOG  ' + message) })
  await store.ready()

  ok('store init', dataDir)

  // ---- 导入
  const vocabScan = await service.importScan({ type: 'vocab', text: VOCAB_MD, source: '2023-2 真题' })
  assert(vocabScan.ok === 12, `词汇解析应为 12，实际 ${vocabScan.ok}`)
  assert(vocabScan.candidates.every((c) => !/解析/u.test(c.item.stem)), '解析文字混进了题干')
  const vocabCommit = await service.importCommit({ type: 'vocab', items: vocabScan.candidates.map((c) => c.item), batch: vocabScan.batch })
  assert(vocabCommit.added.length === 12, '词汇入库失败')
  await service.bankStatus({ type: 'vocab', ids: vocabCommit.added, status: 'active' })
  ok('词汇 markdown 导入', `${vocabCommit.added.length} 条`)

  const grammarScan = await service.importScan({ type: 'grammar', text: JSON.stringify({ items: GRAMMAR }), source: '教材·语法' })
  assert(grammarScan.ok === 45, `语法解析应为 45，实际 ${grammarScan.ok}`)
  const grammarCommit = await service.importCommit({ type: 'grammar', items: grammarScan.candidates.map((c) => c.item) })
  await service.bankStatus({ type: 'grammar', ids: grammarCommit.added, status: 'active' })
  ok('语法 JSON 导入', `${grammarCommit.added.length} 条`)

  const readingScan = await service.importScan({ type: 'reading', text: READING_MD, source: '2024-1 真题' })
  assert(readingScan.ok === 5, `阅读解析应为 5 篇，实际 ${readingScan.ok}`)
  const readingCommit = await service.importCommit({ type: 'reading', items: readingScan.candidates.map((c) => c.item) })
  await service.bankStatus({ type: 'reading', ids: readingCommit.added, status: 'active' })
  ok('阅读导入', `${readingCommit.added.length} 篇`)

  const jaScan = await service.importScan({ type: 'ja2zh', text: JA2ZH_MD, source: '教材·日译中' })
  assert(jaScan.ok === 6, `日译中解析应为 6，实际 ${jaScan.ok}`)
  const jaCommit = await service.importCommit({ type: 'ja2zh', items: jaScan.candidates.map((c) => c.item) })
  await service.bankStatus({ type: 'ja2zh', ids: jaCommit.added, status: 'active' })
  ok('日译中导入', `${jaCommit.added.length} 条`)

  const zhScan = await service.importScan({ type: 'zh2ja', text: ZH2JA_MD, source: '教材·中译日' })
  const zhCommit = await service.importCommit({ type: 'zh2ja', items: zhScan.candidates.map((c) => c.item) })
  await service.bankStatus({ type: 'zh2ja', ids: zhCommit.added, status: 'active' })
  ok('中译日导入', `${zhCommit.added.length} 条`)

  // ---- 组卷
  const blueprints = await service.blueprints()
  const comprehensive = blueprints.find((blueprint) => blueprint.id === 'catti2-comprehensive')
  assert(comprehensive, '缺少综合模板')
  ok('模板可用量', comprehensive.sections.map((section) => `${section.type}:${section.available}`).join(' '))

  const compose = await service.paperCompose({ mode: 'template', blueprintId: 'catti2-comprehensive', seed: 42 })
  if (!compose.ok) lines.push('SHORTFALLS ' + JSON.stringify(compose.shortfalls))
  assert(compose.ok, '综合卷抽不满')
  assert(compose.preview.find((section) => section.type === 'reading').count === 25, '阅读应凑 25 题')
  ok('综合卷预览', `${compose.total_points} 分`)

  const created = await service.paperCreate({ mode: 'template', blueprintId: 'catti2-comprehensive', seed: 42 })
  const paper = created.paper
  assert(paper.sections.length === 3, '试卷分段不对')
  assert(paper.sections.reduce((sum, section) => sum + section.points, 0) === 100, '总分应为 100')
  // 综合按 CATTI 分法：词汇 10×1、语法 40×1、阅读 25×2
  const pointsByType = Object.fromEntries(paper.sections.map((section) => [section.type, section.points]))
  assert(pointsByType.vocab === 10 && pointsByType.grammar === 40 && pointsByType.reading === 50, `权重不对：${JSON.stringify(pointsByType)}`)
  const snapshotItems = paper.sections[0].items[0]
  assert(snapshotItems.answer, '快照里没有答案')
  ok('综合卷建卷', `${paper.id} / ${paper.total_points} 分（词汇10/语法40/阅读50）`)

  // ---- 考试
  const started = await service.examStart({ paperId: paper.id })
  assert(started.exam.status === 'running', '考试没开始')
  const examId = started.exam.id
  assert(started.paper.sections[0].items[0].answer === undefined, '考试视图泄露了答案')
  ok('开考（答案已脱敏）', examId)

  // 全部答对
  for (const [sectionIndex, section] of paper.sections.entries()) {
    for (const [itemIndex, item] of section.items.entries()) {
      if (section.type === 'reading') {
        for (const [questionIndex, question] of item.questions.entries()) {
          started.exam.answers[`${sectionIndex}:${itemIndex}:${questionIndex}`] = question.answer
          await service.examAnswer({
            examId,
            key: `${sectionIndex}:${itemIndex}:${questionIndex}`,
            value: question.answer,
          })
        }
      } else {
        started.exam.answers[`${sectionIndex}:${itemIndex}`] = item.answer
        await service.examAnswer({ examId, key: `${sectionIndex}:${itemIndex}`, value: item.answer })
      }
    }
  }

  const paused1 = await service.examPause({ examId })
  assert(paused1.exam.status === 'paused', '暂停失败')
  const remainingPaused = paused1.exam.remaining_ms
  await new Promise((resolve) => setTimeout(resolve, 1200))
  const statePaused = await service.examState({ examId })
  assert(statePaused.exam.status === 'paused', '暂停状态丢了')
  assert(Math.abs(statePaused.exam.remaining_ms - remainingPaused) < 50, '暂停期间剩余时间在走')
  ok('暂停停表', `${Math.round(remainingPaused / 1000)} 秒`)

  const resumed = await service.examResume({ examId })
  assert(resumed.exam.status === 'running', '恢复失败')
  assert(resumed.exam.pause_count === 1, '暂停次数没记上')
  ok('恢复', `remaining ${Math.round(resumed.exam.remaining_ms / 1000)} 秒`)

  await new Promise((resolve) => setTimeout(resolve, 1100))
  const afterResume = await service.examState({ examId })
  assert(afterResume.exam.remaining_ms < resumed.exam.remaining_ms, '恢复后倒计时没走')
  ok('恢复后继续计时', `remaining ${Math.round(afterResume.exam.remaining_ms / 1000)} 秒`)

  const submitted = await service.examSubmit({ examId })
  const report = submitted.report
  assert(report, '没有成绩单')
  assert(report.total === 100, `全对应为 100 分，实际 ${report.total}`)
  assert(report.pause_count === 1, '成绩单暂停次数不对')
  ok('综合判分', `${report.total}/${report.max}，用时 ${report.used_seconds} 秒`)

  const exportResult = await service.reportExport({ reportId: report.id })
  assert(fs.existsSync(exportResult.file), '成绩导出文件不存在')
  ok('成绩导出', exportResult.file)

  // ---- 实务卷（待判分 → 双评写回）
  const practiceCompose = await service.paperCompose({ mode: 'template', blueprintId: 'catti2-practice', seed: 7 })
  assert(practiceCompose.ok, '实务卷抽不满：' + JSON.stringify(practiceCompose.shortfalls))
  const practicePaper = (await service.paperCreate({ mode: 'template', blueprintId: 'catti2-practice', seed: 7 })).paper
  const practiceExam = await service.examStart({ paperId: practicePaper.id })
  assert(practiceExam.exam.status === 'running', '实务考试没开始')
  await service.examAnswer({ examId: practiceExam.exam.id, key: '0:0', value: '这是译文。' })
  const practiceReport = (await service.examSubmit({ examId: practiceExam.exam.id })).report
  const practiceSection = practiceReport.sections.find((section) => section.type === 'ja2zh')
  assert(practiceSection && practiceSection.graded === false, '实务段应标记为待判分')
  assert(practiceReport.pass === null, '待判分时不应给合否')
  assert(practiceReport.status === 'pending_review', `交卷后应为 pending_review，实际 ${practiceReport.status}`)
  ok('实务卷交卷', `status=${practiceReport.status} total=${practiceReport.total}/${practiceReport.max}`)

  const pendingList = await service.gradePending()
  assert(pendingList.pending.some((entry) => entry.report_id === practiceReport.id), '待判清单里没有这份卷')
  const material = await service.gradeMaterial({ reportId: practiceReport.id })
  assert(material.sections.length === 2, '应有日译中、中译日两段待评')
  assert(material.sections[0].items[0].original, '材料里缺原文')
  assert(material.sections[0].items[0].translation === '这是译文。', '材料里缺考生译文')
  ok('判分材料', `${material.sections.length} 段，含原文/译文/契约`)

  // 分差超过阈值 → 必须先补第三评
  let needThird = false
  try {
    await service.gradeCommit({
      reportId: practiceReport.id,
      threshold: 3,
      reviews: [
        { section_index: 0, reviewer: 'A', score: 40 },
        { section_index: 0, reviewer: 'B', score: 46 },
      ],
    })
  } catch (error) {
    needThird = error.code === 'NEED_REVIEW'
  }
  assert(needThird, 'A/B 差 6 分超过阈值，应要求第三评')

  const graded = await service.gradeCommit({
    reportId: practiceReport.id,
    threshold: 3,
    reviews: [
      { section_index: 0, reviewer: 'A', score: 40 },
      { section_index: 0, reviewer: 'B', score: 46 },
      { section_index: 0, reviewer: 'C', score: 44 },
      { section_index: 1, reviewer: 'A', score: 30 },
      { section_index: 1, reviewer: 'B', score: 32 },
    ],
  })
  assert(graded.status === 'graded', '写回后应转 graded')
  const section0 = graded.report.sections[0]
  assert(section0.earned === 43.3, `三评均值应为 43.3，实际 ${section0.earned}`)
  assert(section0.review.method === 'mean3', '应记 mean3')
  assert(graded.report.sections[1].earned === 31, '双评均值应为 31')
  assert(graded.report.total === 74.3, `总分应为 43.3+31=74.3，实际 ${graded.report.total}`)
  ok('双评/三评写回', `${graded.report.total}/${graded.report.max}，状态 ${graded.status}`)

  // ---- 到点自动交卷
  const quickPaper = (await service.paperCreate({
    mode: 'free',
    sections: [{ type: 'ja2zh', count: 1, points: 10 }],
    title: '到点交卷测试',
    duration_min: 1,
    seed: 99,
  })).paper
  const quickExam = (await service.examStart({ paperId: quickPaper.id })).exam
  const stored = (await store.exams()).find((entry) => entry.id === quickExam.id)
  stored.duration_ms = 1
  stored.active_started_at = Date.now() - 5000
  await store.saveExam(stored)
  const ticked = await service.tick()
  assert(ticked.auto_submitted.length >= 1, '到点没有自动交卷')
  const autoReport = (await service.reportGet({ reportId: ticked.auto_submitted[0].report_id })).report
  assert(autoReport.submit_reason === 'timeout', `交卷原因应为 timeout，实际 ${autoReport.submit_reason}`)
  ok('到点自动交卷', `${autoReport.id} reason=timeout`)

  // ---- 断点恢复：重启 store 后还能读回场次
  const secondStore = new CattiStore({ dataDir, logger: () => {} })
  const secondService = new CattiService({ store: secondStore })
  await secondStore.ready()
  const freshStart = await secondService.examStart({ paperId: paper.id })
  assert(freshStart.exam.status === 'running', '第二场没开始')
  const thirdStore = new CattiStore({ dataDir, logger: () => {} })
  const thirdService = new CattiService({ store: thirdStore })
  await thirdStore.ready()
  const recovered = await thirdService.examState({})
  assert(recovered.exam && recovered.exam.id === freshStart.exam.id, '重启后没恢复进行中的考试')
  assert(recovered.exam.remaining_ms > 0, '恢复后剩余时间不对')
  ok('断点恢复', `${recovered.exam.paper_title}`)

  // ---- 手改文件生效
  const vocabFile = path.join(dataDir, 'banks', 'vocab.json')
  const onDisk = JSON.parse(fs.readFileSync(vocabFile, 'utf8'))
  onDisk.items[0].stem = '手改过的题干'
  onDisk.items[0].updated_at = new Date().toISOString()
  fs.writeFileSync(vocabFile, JSON.stringify(onDisk, null, 2), 'utf8')
  await new Promise((resolve) => setTimeout(resolve, 30))
  const reread = await thirdService.bankGet({ type: 'vocab', id: onDisk.items[0].id })
  assert(reread.item.stem === '手改过的题干', '手改文件没生效')
  ok('手改题库文件生效', onDisk.items[0].id)

  // ---- 缺答案的题不能进卷
  const missing = normalizeItem('vocab', { stem: '没有答案的题', options: ['A', 'B', 'C', 'D'], source: '测试' })
  assert(missing.status === 'needs_human', '缺答案应为 needs_human')
  ok('缺答案自动转 needs_human')
}

main()
  .catch((error) => bad('主流程', error))
  .finally(() => {
    lines.push(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`)
    fs.writeFileSync(outFile, lines.join('\n'))
  })
