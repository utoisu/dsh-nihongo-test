/**
 * 公共小工具：题型常量、id、指纹、原子写、答案归一化、字数。
 * 不依赖宿主服务，Host 侧随处可用。
 */
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'

export const TYPES = ['vocab', 'grammar', 'reading', 'ja2zh', 'zh2ja']

export const TYPE_LABEL = {
  vocab: '词汇',
  grammar: '语法',
  reading: '阅读理解',
  ja2zh: '日译中',
  zh2ja: '中译日',
}

export const ID_PREFIX = {
  vocab: 'V',
  grammar: 'G',
  reading: 'R',
  ja2zh: 'JC',
  zh2ja: 'CJ',
}

export const STATUS_LABEL = {
  candidate: '候选',
  active: '在库',
  disputed: '争议',
  rejected: '已拒',
  needs_human: '待人工',
}

export const DIFFICULTIES = ['L1', 'L2', 'L3']

export const OBJECTIVE_TYPES = new Set(['vocab', 'grammar', 'reading'])
export const PRACTICE_TYPES = new Set(['ja2zh', 'zh2ja'])

export function nowIso() {
  return new Date().toISOString()
}

export function hashOf(text) {
  return createHash('sha1').update(String(text ?? ''), 'utf8').digest('hex').slice(0, 16)
}

export function pad4(n) {
  return String(n).padStart(4, '0')
}

/** 中日文按「非空白字符」计字数，和考试答题卡上的字数统计一致。 */
export function countChars(text) {
  return [...String(text ?? '').replace(/\s/gu, '')].length
}

/** 选项字母统一成 'A'..'E'。接受 'b'、'2'、0 基下标、带顿号的写法。 */
export function normalizeAnswer(value, optionCount = 0) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'number' && Number.isInteger(value)) {
    if (value >= 0 && value < Math.max(optionCount, 1)) return String.fromCharCode(65 + value)
    return ''
  }
  const raw = String(value).trim().toUpperCase().replace(/[.。、,，:：)）\s]/gu, '')
  if (/^[A-Z]$/u.test(raw)) return raw
  if (/^\d+$/u.test(raw)) {
    const n = Number(raw)
    // 1 基（1..5）优先；越界但仍在 0..4 的按 0 基兜一下。
    if (n >= 1 && n <= Math.max(optionCount, 5)) return String.fromCharCode(64 + n)
    if (n >= 0 && n < Math.max(optionCount, 1)) return String.fromCharCode(65 + n)
  }
  return ''
}

export async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true })
}

export async function readJson(file, fallback) {
  try {
    const text = await fs.readFile(file, 'utf8')
    if (!text.trim()) return fallback
    return JSON.parse(text)
  } catch (error) {
    if (error && error.code === 'ENOENT') return fallback
    throw error
  }
}

const writeChains = new Map()

/**
 * 原子写：先写临时文件再 rename，崩溃时不会留下半个 JSON。
 * 同一路径的写按调用顺序串行，避免并发覆盖。
 */
export function writeJson(file, value) {
  const previous = writeChains.get(file) ?? Promise.resolve()
  const next = previous
    .catch(() => {})
    .then(async () => {
      await ensureDir(path.dirname(file))
      const body = JSON.stringify(value, null, 2) + '\n'
      const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`
      await fs.writeFile(tmp, body, 'utf8')
      await fs.rename(tmp, file)
      return true
    })
  writeChains.set(file, next)
  return next
}

export async function statOrNull(file) {
  try {
    const st = await fs.stat(file)
    return { mtimeMs: st.mtimeMs, size: st.size }
  } catch {
    return null
  }
}

export function asArray(value) {
  if (Array.isArray(value)) return value
  if (value && typeof value === 'object' && Array.isArray(value.items)) return value.items
  return []
}

export function str(value, fallback = '') {
  return typeof value === 'string' ? value : fallback
}

export function finiteNumber(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

export function round1(value) {
  return Math.round(value * 10) / 10
}

/** 稳定的 JSON 深比较指纹，用于去重与「内容是否真的变了」。 */
export function fingerprint(value) {
  return hashOf(JSON.stringify(value))
}

export function truncate(text, max) {
  const s = String(text ?? '').replace(/\s+/gu, ' ').trim()
  return s.length > max ? s.slice(0, max) + '…' : s
}
