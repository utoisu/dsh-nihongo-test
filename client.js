/**
 * CATTI 二级模考 —— Web 页面的 Client 半边。
 *
 * 一个页面四个标签：题库 / 组卷 / 考试 / 成绩。
 * 数据一律走本机接口（/dsh-nihongo-test/api），接口地址与 token 由 Host 在启动时注入
 * globalThis.__DSH_NIHONGO_TEST__；拿不到注入时退回相对路径。
 *
 * 样式只用 --dsw-alias-* 主题 token，跟随明暗切换。
 */
window.__ModuleLoader__.load({
  id: 'dsh-nihongo-test',
  factory(require) {
    var module = { exports: {} }
    var exports = module.exports
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useRef, useMemo, useCallback } = React

    const NS = 'dsh-nihongo-test'

    // ------------------------------------------------------------------ 文案

    const DICT = {
      zh: {
        panel: 'CATTI 模考',
        title: 'CATTI 日语笔译二级 · 模考',
        tabBank: '题库',
        tabPaper: '组卷',
        tabExam: '考试',
        tabReport: '成绩',
        refresh: '刷新',
        loading: '读取中…',
        empty: '还没有内容。',
        examRunning: '考试进行中',
        bankEmpty: '这个库还是空的。先在下面导入，或在「组卷」里看看能抽到什么。',
        import: '导入',
        importScan: '解析预览',
        importCommit: '入库',
        source: '来源',
        difficulty: '难度',
        status: '状态',
        search: '搜索题干、来源、标签',
        all: '全部',
      },
      en: {
        panel: 'CATTI mock',
        title: 'CATTI Japanese translation level 2 · mock exam',
        tabBank: 'Banks',
        tabPaper: 'Papers',
        tabExam: 'Exam',
        tabReport: 'Reports',
        refresh: 'Refresh',
        loading: 'Loading…',
        empty: 'Nothing here yet.',
        examRunning: 'Exam in progress',
        bankEmpty: 'This bank is empty. Import below, or check what Papers can draw.',
        import: 'Import',
        importScan: 'Preview',
        importCommit: 'Add to bank',
        source: 'Source',
        difficulty: 'Level',
        status: 'Status',
        search: 'Search stem, source, tags',
        all: 'All',
      },
    }

    const TYPES = [
      ['vocab', '词汇', 'Vocabulary'],
      ['grammar', '语法', 'Grammar'],
      ['reading', '阅读理解', 'Reading'],
      ['ja2zh', '日译中', 'JA→ZH'],
      ['zh2ja', '中译日', 'ZH→JA'],
    ]
    const TYPE_LABEL = Object.fromEntries(TYPES.map(([key, zh, en]) => [key, { zh, en }]))
    const STATUS_LABEL = {
      candidate: '候选',
      active: '在库',
      disputed: '争议',
      rejected: '已拒',
      needs_human: '待人工',
    }
    const STATUS_TONE = { candidate: 'warn', active: 'ok', disputed: 'error', rejected: 'muted', needs_human: 'error' }

    // ------------------------------------------------------------------ 样式

    const CSS = [
      '[data-cm]{--cm-gap:16px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}',
      '[data-cm] *{box-sizing:border-box}',
      // 实务成绩单：原文 / 你的译文 / 参考译文 三栏对照 + 批改意见块
      '[data-cm] .cm-pair{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-top:10px}',
      '[data-cm] .cm-pair-col{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:10px;background:var(--dsw-alias-bg-layer-2)}',
      '[data-cm] .cm-pair-label{font-size:12px;color:var(--dsw-alias-label-secondary);margin-bottom:6px}',
      '[data-cm] .cm-pair-text{white-space:pre-wrap;font-size:13px;line-height:1.8}',
      '[data-cm] .cm-review{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:10px 12px;margin-top:10px;background:var(--dsw-alias-bg-layer-2)}',
      '[data-cm] .cm-review-head{font-weight:600;font-size:13px;margin-bottom:6px}',
      '[data-cm] .cm-list-plain{margin:4px 0 0 18px;padding:0}',
      '@media(max-width:760px){[data-cm] .cm-pair{grid-template-columns:minmax(0,1fr)}}',      '[data-cm].cm-root{max-width:1180px;margin:0 auto;padding:calc(var(--dsh-frame-top-clearance,0px) + 20px) 28px 64px;max-height:100vh;overflow-y:auto;overscroll-behavior:contain}',
      '[data-cm] .cm-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:6px}',
      '[data-cm] .cm-title{margin:0;font-size:18px;line-height:26px;font-weight:600}',
      '[data-cm] .cm-sub{margin:2px 0 0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);word-break:break-all}',
      '[data-cm] .cm-actions{display:flex;align-items:center;gap:8px;flex:none}',
      '[data-cm] .cm-tabs{display:flex;gap:4px;margin:18px 0 18px;border-bottom:1px solid var(--dsw-alias-border-l1)}',
      '[data-cm] .cm-tab{position:relative;padding:8px 12px 10px;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;cursor:pointer}',
      '[data-cm] .cm-tab:hover{color:var(--dsw-alias-label-primary)}',
      '[data-cm] .cm-tab.is-on{color:var(--dsw-alias-label-primary);font-weight:600}',
      '[data-cm] .cm-tab.is-on::after{content:"";position:absolute;left:8px;right:8px;bottom:-1px;height:2px;border-radius:2px;background:var(--dsw-alias-brand-primary)}',
      '[data-cm] .cm-grid{display:grid;gap:16px}',
      '[data-cm] .cm-grid-2{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}',
      '[data-cm] .cm-grid-side{grid-template-columns:210px minmax(0,1fr)}',
      '[data-cm] .cm-card{border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);padding:16px}',
      '[data-cm] .cm-card+.cm-card{margin-top:12px}',
      '[data-cm] .cm-card-title{margin:0 0 10px;font-size:14px;line-height:22px;font-weight:600;display:flex;align-items:center;gap:8px}',
      '[data-cm] .cm-hint{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
      '[data-cm] .cm-muted{color:var(--dsw-alias-label-secondary)}',
      '[data-cm] .cm-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:30px;padding:0 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;cursor:pointer;white-space:nowrap}',
      '[data-cm] .cm-btn:hover{background:var(--dsw-alias-bg-layer-2)}',
      '[data-cm] .cm-btn:disabled{opacity:.45;cursor:default}',
      '[data-cm] .cm-btn-sm{height:26px;padding:0 9px;font-size:12px}',
      '[data-cm] .cm-btn-primary{border-color:transparent;background:var(--dsw-alias-brand-primary);color:#fff}',
      '[data-cm] .cm-btn-primary:hover{filter:brightness(1.06);background:var(--dsw-alias-brand-primary)}',
      '[data-cm] .cm-btn-danger{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}',
      '[data-cm] .cm-chip{display:inline-flex;align-items:center;height:20px;padding:0 7px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:20px;white-space:nowrap}',
      '[data-cm] .cm-chip-ok{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 14%,transparent);color:var(--dsw-alias-state-success-primary)}',
      '[data-cm] .cm-chip-warn{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 16%,transparent);color:var(--dsw-alias-state-warn-primary)}',
      '[data-cm] .cm-chip-error{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 14%,transparent);color:var(--dsw-alias-state-error-primary)}',
      '[data-cm] .cm-input,[data-cm] .cm-select,[data-cm] .cm-area{width:100%;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-base);color:inherit;font:inherit;outline:none}',
      '[data-cm] .cm-input,[data-cm] .cm-select{height:30px;padding:0 9px}',
      '[data-cm] .cm-area{padding:9px;min-height:180px;resize:vertical;line-height:1.7}',
      '[data-cm] .cm-area:focus,[data-cm] .cm-input:focus,[data-cm] .cm-select:focus{border-color:var(--dsw-alias-brand-primary)}',
      '[data-cm] .cm-field{display:flex;flex-direction:column;gap:5px;min-width:0}',
      '[data-cm] .cm-field>span{font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '[data-cm] .cm-row{display:flex;flex-wrap:wrap;align-items:center;gap:8px}',
      '[data-cm] .cm-bank-nav{display:flex;flex-direction:column;gap:2px}',
      '[data-cm] .cm-bank-item{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:7px 10px;border:0;border-radius:8px;background:transparent;color:inherit;font:inherit;cursor:pointer;text-align:left}',
      '[data-cm] .cm-bank-item:hover{background:var(--dsw-alias-bg-layer-2)}',
      '[data-cm] .cm-bank-item.is-on{background:var(--dsw-alias-bg-layer-2);font-weight:600}',
      '[data-cm] .cm-list{display:flex;flex-direction:column}',
      '[data-cm] .cm-rowitem{display:grid;grid-template-columns:52px minmax(0,1fr) auto;gap:10px;align-items:center;padding:8px 6px;border-bottom:1px solid var(--dsw-alias-border-l1);cursor:pointer}',
      '[data-cm] .cm-rowitem:last-child{border-bottom:0}',
      '[data-cm] .cm-rowitem:hover{background:var(--dsw-alias-bg-layer-2)}',
      '[data-cm] .cm-rowitem.is-on{background:var(--dsw-alias-bg-layer-2);box-shadow:inset 2px 0 0 var(--dsw-alias-brand-primary)}',
      // 滚动条：Chromium 里只要写了 ::-webkit-scrollbar 就变成常显的经典滚动条，不用等悬浮
      '[data-cm] ::-webkit-scrollbar{width:10px;height:10px}',
      '[data-cm] ::-webkit-scrollbar-track{background:transparent}',
      '[data-cm] ::-webkit-scrollbar-thumb{background:color-mix(in srgb,var(--dsw-alias-label-secondary) 32%,transparent);border-radius:999px;border:2px solid transparent;background-clip:padding-box}',
      '[data-cm] ::-webkit-scrollbar-thumb:hover{background:color-mix(in srgb,var(--dsw-alias-label-secondary) 55%,transparent);border:2px solid transparent;background-clip:padding-box}',
      '[data-cm] ::-webkit-scrollbar-corner{background:transparent}',
      '[data-cm] *{scrollbar-width:thin;scrollbar-color:var(--dsw-alias-border-l2) transparent}',
      // 可滚区域：自己滚，滚到底不带着页面一起跑（overscroll-behavior:contain）
      '[data-cm] .cm-scroll{overflow-y:auto;overscroll-behavior:contain;max-height:calc(100vh - 330px);padding-right:4px}',
      '[data-cm] .cm-scroll-sm{overflow-y:auto;overscroll-behavior:contain;max-height:calc(100vh - 520px);padding-right:4px}',
      '[data-cm] .cm-scroll-detail{max-height:calc(100vh - 240px);overflow-y:auto;overscroll-behavior:contain}',
      '[data-cm] .cm-id{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '[data-cm] .cm-preview{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '[data-cm] .cm-meta{display:flex;gap:6px;align-items:center;flex-wrap:wrap;justify-content:flex-end}',
      '[data-cm] .cm-stem{font-size:14px;line-height:24px;margin:0 0 12px;white-space:pre-wrap}',
      '[data-cm] .cm-passage{white-space:pre-wrap;line-height:1.9;font-size:14px;margin:0 0 16px;max-height:44vh;overflow:auto;padding-right:6px}',
      '[data-cm] .cm-options{display:flex;flex-direction:column;gap:6px}',
      '[data-cm] .cm-option{display:flex;gap:10px;align-items:flex-start;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer;line-height:1.6}',
      '[data-cm] .cm-option:hover{border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2)}',
      '[data-cm] .cm-option.is-on{border-color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 10%,transparent)}',
      '[data-cm] .cm-option-key{flex:none;width:18px;height:18px;border-radius:50%;border:1px solid var(--dsw-alias-border-l2);display:inline-flex;align-items:center;justify-content:center;font-size:11px;font-weight:600}',
      '[data-cm] .cm-option.is-on .cm-option-key{background:var(--dsw-alias-brand-primary);border-color:transparent;color:#fff}',
      '[data-cm] .cm-q-block{padding:14px 0;border-top:1px dashed var(--dsw-alias-border-l1)}',
      '[data-cm] .cm-q-block:first-of-type{border-top:0;padding-top:0}',
      '[data-cm] .cm-section-head{display:flex;align-items:baseline;gap:10px;margin:0 0 12px;font-size:14px;font-weight:600}',
      '[data-cm] .cm-timer{font-variant-numeric:tabular-nums;font-size:22px;line-height:28px;font-weight:600;letter-spacing:.5px}',
      '[data-cm] .cm-timer.is-urgent{color:var(--dsw-alias-state-error-primary)}',
      '[data-cm] .cm-exam-head{position:sticky;top:0;z-index:3;display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:12px 16px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1)}',
      '[data-cm] .cm-exam-body{display:grid;grid-template-columns:minmax(0,1fr) 208px;gap:16px;align-items:start;margin-top:12px}',
      '[data-cm] .cm-card-wrap{position:sticky;top:76px}',
      '[data-cm] .cm-cells{display:flex;flex-wrap:wrap;gap:6px}',
      '[data-cm] .cm-cell{width:26px;height:26px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:inherit;font:inherit;font-size:11px;cursor:pointer;font-variant-numeric:tabular-nums}',
      '[data-cm] .cm-cell.is-done{background:var(--dsw-alias-brand-primary);border-color:transparent;color:#fff}',
      '[data-cm] .cm-cell.is-current{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      '[data-cm] .cm-cell-group{margin-bottom:10px}',
      '[data-cm] .cm-cell-title{font-size:11px;color:var(--dsw-alias-label-secondary);margin:0 0 5px}',
      '[data-cm] .cm-pause{position:relative}',
      '[data-cm] .cm-pause-banner{position:sticky;top:64px;z-index:2;margin:-4px 0 14px;padding:9px 12px;border-radius:8px;font-size:12px;line-height:18px;font-weight:600;background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 14%,transparent);color:var(--dsw-alias-state-warn-primary)}',
      '[data-cm] .cm-score{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin-bottom:12px}',
      '[data-cm] .cm-score-card{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:12px}',
      '[data-cm] .cm-score-num{font-size:26px;line-height:32px;font-weight:600;font-variant-numeric:tabular-nums}',
      '[data-cm] .cm-score-label{font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '[data-cm] .cm-table{width:100%;border-collapse:collapse}',
      '[data-cm] .cm-table th,[data-cm] .cm-table td{padding:7px 8px;border-bottom:1px solid var(--dsw-alias-border-l1);text-align:left;font-size:12px;vertical-align:top}',
      '[data-cm] .cm-table th{color:var(--dsw-alias-label-secondary);font-weight:500}',
      '[data-cm] .cm-table td.num{text-align:right;font-variant-numeric:tabular-nums}',
      '[data-cm] details.cm-details{border-top:1px solid var(--dsw-alias-border-l1);padding:8px 0}',
      '[data-cm] details.cm-details summary{cursor:pointer;font-size:12px;line-height:20px;color:var(--dsw-alias-label-secondary);list-style:none}',
      '[data-cm] details.cm-details summary::-webkit-details-marker{display:none}',
      '[data-cm] details.cm-details summary::before{content:"▸ ";color:var(--dsw-alias-label-secondary)}',
      '[data-cm] details.cm-details[open] summary::before{content:"▾ "}',
      '[data-cm] .cm-verdict{display:flex;gap:8px;align-items:baseline;font-size:12px;line-height:20px}',
      '[data-cm] .cm-verdict .ok{color:var(--dsw-alias-state-success-primary)}',
      '[data-cm] .cm-verdict .bad{color:var(--dsw-alias-state-error-primary)}',
      '[data-cm] .cm-toast{position:fixed;right:24px;bottom:24px;z-index:60;max-width:360px;padding:10px 14px;border-radius:10px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-overlay);box-shadow:0 8px 24px rgba(0,0,0,.16);font-size:12px;line-height:18px}',
      '[data-cm] .cm-toast.is-error{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}',
      '[data-cm] .cm-modal-mask{position:fixed;inset:0;z-index:70;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.32)}',
      '[data-cm] .cm-modal{width:min(520px,92vw);border-radius:12px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-overlay);padding:18px}',
      '[data-cm] .cm-modal-title{margin:0 0 8px;font-size:14px;font-weight:600}',
      '[data-cm] .cm-modal-foot{display:flex;justify-content:flex-end;gap:8px;margin-top:18px}',
      '[data-cm] .cm-empty{padding:28px 8px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:12px}',
      '[data-cm] .cm-warn{border-left:3px solid var(--dsw-alias-state-warn-primary);padding:6px 10px;background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 8%,transparent);border-radius:0 8px 8px 0;font-size:12px;line-height:19px;margin:8px 0}',
      '[data-cm] .cm-error-list{color:var(--dsw-alias-state-error-primary);font-size:12px}',
      '[data-cm] .cm-spacer{height:8px}',
      '[data-cm] .cm-kv{display:grid;grid-template-columns:88px minmax(0,1fr);gap:6px 10px;font-size:12px;line-height:19px}',
      '[data-cm] .cm-kv dt{color:var(--dsw-alias-label-secondary)}',
      '[data-cm] .cm-kv dd{margin:0;white-space:pre-wrap;word-break:break-word}',
      '@media(max-width:900px){[data-cm].cm-root{padding:16px}[data-cm] .cm-grid-side,[data-cm] .cm-grid-2,[data-cm] .cm-exam-body{grid-template-columns:minmax(0,1fr)}[data-cm] .cm-card-wrap{position:static}[data-cm] .cm-score{grid-template-columns:1fr}}',
    ].join('')

    function useStyles() {
      useEffect(() => {
        if (typeof document === 'undefined') return undefined
        if (document.getElementById('cm-core-style')) return undefined
        const style = document.createElement('style')
        style.id = 'cm-core-style'
        style.textContent = CSS
        document.head.appendChild(style)
        return undefined
      }, [])
    }

    // ------------------------------------------------------------------ 接口

    function apiBase() {
      const injected = globalThis.__DSH_NIHONGO_TEST__
      const url = injected && typeof injected.url === 'string' && injected.url ? injected.url.replace(/\/+$/u, '') : '/dsh-nihongo-test'
      const token = injected && typeof injected.token === 'string' ? injected.token : ''
      return { url: url + '/api', token }
    }

    async function call(action, payload) {
      const { url, token } = apiBase()
      let response
      try {
        response = await fetch(url, {
          method: 'POST',
          cache: 'no-store',
          headers: { 'content-type': 'application/json', ...(token ? { 'x-catti-token': token } : {}) },
          body: JSON.stringify({ action, payload: payload ?? {} }),
        })
      } catch (error) {
        throw new Error('连不上本机接口：' + String(error?.message ?? error))
      }
      const text = await response.text()
      let data = null
      try {
        data = text ? JSON.parse(text) : null
      } catch {
        throw new Error('接口返回的不是 JSON：' + text.slice(0, 120))
      }
      if (!data || data.ok !== true) {
        const message = data?.error?.message ?? `HTTP ${response.status}`
        const error = new Error(message)
        error.code = data?.error?.code
        throw error
      }
      return data.data
    }

    // ------------------------------------------------------------------ 小元件

    function Btn(props) {
      const className = ['cm-btn', props.kind ? `cm-btn-${props.kind}` : '', props.size === 'sm' ? 'cm-btn-sm' : ''].filter(Boolean).join(' ')
      return h('button', {
        type: 'button',
        className: className + (props.className ? ` ${props.className}` : ''),
        onClick: props.onClick,
        disabled: props.disabled,
        title: props.title,
      }, props.children)
    }

    function Chip(props) {
      return h('span', { className: `cm-chip${props.tone ? ` cm-chip-${props.tone}` : ''}` }, props.children)
    }

    function Field(props) {
      return h('label', { className: 'cm-field' },
        h('span', null, props.label),
        props.children,
        props.hint ? h('span', { className: 'cm-hint' }, props.hint) : null,
      )
    }

    function Select(props) {
      return h('select', {
        className: 'cm-select',
        value: props.value,
        onChange: (event) => props.onChange(event.target.value),
        disabled: props.disabled,
      }, (props.options ?? []).map((option) => h('option', { key: option.value, value: option.value }, option.label)))
    }

    function Toast(props) {
      if (!props.message) return null
      return h('div', { className: `cm-toast${props.tone === 'error' ? ' is-error' : ''}`, role: 'status' }, props.message)
    }

    function Modal(props) {
      useEffect(() => {
        const onKey = (event) => {
          if (event.key === 'Escape') props.onClose()
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [])
      return h('div', { className: 'cm-modal-mask', onClick: props.onClose },
        h('div', { className: 'cm-modal', onClick: (event) => event.stopPropagation() },
          h('h3', { className: 'cm-modal-title' }, props.title),
          props.children,
          h('div', { className: 'cm-modal-foot' }, props.footer),
        ),
      )
    }

    function Empty(props) {
      return h('div', { className: 'cm-empty' }, props.children)
    }

    function formatDuration(totalSeconds) {
      const total = Math.max(0, Math.round(Number(totalSeconds) || 0))
      const minutes = Math.floor(total / 60)
      const seconds = total % 60
      return `${minutes}:${String(seconds).padStart(2, '0')}`
    }

    function formatLong(seconds) {
      const total = Math.max(0, Math.round(Number(seconds) || 0))
      const hours = Math.floor(total / 3600)
      const minutes = Math.floor((total % 3600) / 60)
      if (hours > 0) return `${hours} 小时 ${minutes} 分`
      return `${minutes} 分 ${total % 60} 秒`
    }

    /** 服务端存的是 UTC ISO，展示按本机时区。 */
    function formatTime(iso) {
      if (!iso) return '—'
      const date = new Date(iso)
      if (Number.isNaN(date.getTime())) return '—'
      const pad = (value) => String(value).padStart(2, '0')
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
    }

    function countChars(text) {
      return [...String(text ?? '').replace(/\s/gu, '')].length
    }

    // ------------------------------------------------------------------ 题库

    function ImportPanel(props) {
      const [type, setType] = useState('vocab')
      const [format, setFormat] = useState('auto')
      const [source, setSource] = useState('')
      const [text, setText] = useState('')
      const [scan, setScan] = useState(null)
      const [picked, setPicked] = useState({})
      const [busy, setBusy] = useState(false)

      const runScan = async () => {
        if (!text.trim()) return props.toast('先粘贴内容或选一个文件', 'error')
        setBusy(true)
        try {
          const result = await call('import.scan', { type, format, text, source })
          setScan(result)
          const pre = {}
          result.candidates.forEach((candidate) => {
            if (candidate.ok) pre[candidate.index] = candidate.item.status !== 'needs_human'
          })
          setPicked(pre)
          props.toast(`解析 ${result.total} 条：可入库 ${result.ok} 条，失败 ${result.failed} 条`)
        } catch (error) {
          props.toast(error.message, 'error')
        } finally {
          setBusy(false)
        }
      }

      const commit = async () => {
        if (!scan) return
        const items = scan.candidates
          .filter((candidate) => candidate.ok && picked[candidate.index])
          .map((candidate) => candidate.item)
        if (items.length === 0) return props.toast('没有勾选任何条目', 'error')
        setBusy(true)
        try {
          const result = await call('import.commit', { type, items, batch: scan.batch, source })
          props.toast(`已入库 ${result.added.length} 条，跳过重复 ${result.skipped.length} 条`)
          setScan(null)
          setText('')
          props.onChanged()
        } catch (error) {
          props.toast(error.message, 'error')
        } finally {
          setBusy(false)
        }
      }

      const importCorpus = async () => {
        setBusy(true)
        try {
          // 只导 L（整篇）。S 小段不进实务卷，等审核代理上线再批量导。
          const result = await call('import.corpus', { kind: 'L', limit: 40 })
          props.toast(`教材 L 段：日译中 +${result.ja2zh.added}，中译日 +${result.zh2ja.added}（都是候选，各取前 20 条）`)
          props.onChanged()
        } catch (error) {
          props.toast(error.message, 'error')
        } finally {
          setBusy(false)
        }
      }

      const onFile = async (event) => {
        const file = event.target.files?.[0]
        if (!file) return
        const body = await file.text()
        setText(body)
        setSource(source || `文件：${file.name}`)
        if (/\.json$/iu.test(file.name)) setFormat('json')
      }

      return h('div', { className: 'cm-card' },
        h('h3', { className: 'cm-card-title' }, '导入（解析与入库是两步，先看预览再决定）'),
        h('div', { className: 'cm-row' },
          h('div', { style: { width: 132 } }, h(Field, { label: '题型' }, h(Select, {
            value: type,
            onChange: setType,
            options: TYPES.map(([key, zh]) => ({ value: key, label: zh })),
          }))),
          h('div', { style: { width: 132 } }, h(Field, { label: '格式' }, h(Select, {
            value: format,
            onChange: setFormat,
            options: [
              { value: 'auto', label: '自动识别' },
              { value: 'markdown', label: 'Markdown' },
              { value: 'json', label: 'JSON' },
            ],
          }))),
          h('div', { style: { flex: '1 1 240px' } }, h(Field, { label: '来源（会写进每条题）' },
            h('input', { className: 'cm-input', value: source, placeholder: '如 2023-2 真题 / 强化班 p.34', onChange: (event) => setSource(event.target.value) }),
          )),
          h('div', { style: { flex: '0 0 auto' } }, h(Field, { label: '本机文件' },
            h('input', { type: 'file', accept: '.json,.md,.txt,text/plain', onChange: onFile, style: { fontSize: 12 } }),
          )),
        ),
        h('div', { className: 'cm-spacer' }),
        h('textarea', {
          className: 'cm-area',
          value: text,
          placeholder: type === 'ja2zh' || type === 'zh2ja'
            ? '直接粘贴原文；多段用单独一行 --- 分隔；参考译文另起一行写「参考译文：…」'
            : '粘贴题目文本；选择题每题写 1. 题干 / A. 选项 / B. 选项 / C. 选项 / D. 选项 / 答案：B / 解析：…',
          onChange: (event) => setText(event.target.value),
        }),
        h('div', { className: 'cm-row', style: { marginTop: 10 } },
          h(Btn, { kind: 'primary', onClick: runScan, disabled: busy }, '解析预览'),
          h(Btn, { onClick: importCorpus, disabled: busy }, '导入 L 段（整篇）'),
          h('span', { className: 'cm-hint' }, 'JSON 可直接贴 { items: [...] }；无答案的题会进「待人工」队列，不会自动入库为 active。'),
        ),
        h('p', { className: 'cm-hint', style: { marginTop: 6 } },
          '「导入 L 段」只收整篇（教材里的大段/真题），各题型最多 20 条，进来是候选；S 小段不进实务卷，等审核代理上线再批量导。'),
        scan ? h('div', { style: { marginTop: 12 } },
          h('div', { className: 'cm-row' },
            h('strong', null, `解析结果：${scan.ok} / ${scan.total} 条可入库`),
            scan.failed > 0 ? h(Chip, { tone: 'error' }, `${scan.failed} 条解析失败`) : null,
            scan.needs_human > 0 ? h(Chip, { tone: 'warn' }, `${scan.needs_human} 条缺答案`) : null,
            h('span', { style: { marginLeft: 'auto' } },
              h(Btn, { kind: 'primary', size: 'sm', onClick: commit, disabled: busy }, `入库 ${Object.values(picked).filter(Boolean).length} 条`),
            ),
          ),
          (scan.warnings ?? []).slice(0, 6).map((warning, index) => h('div', { key: `w${index}`, className: 'cm-warn' }, warning)),
          scan.failed > 0 ? h('div', { className: 'cm-error-list' },
            scan.candidates.filter((candidate) => !candidate.ok).slice(0, 8).map((candidate) => h('div', { key: `f${candidate.index}` }, `#${candidate.index + 1} ${candidate.error}`)),
          ) : null,
          h('div', { className: 'cm-list', style: { marginTop: 8, maxHeight: 320, overflow: 'auto' } },
            scan.candidates.filter((candidate) => candidate.ok).map((candidate) => h('label', {
              key: `c${candidate.index}`,
              className: 'cm-rowitem',
              style: { gridTemplateColumns: '20px 52px minmax(0,1fr) auto', cursor: 'pointer' },
            },
            h('input', {
              type: 'checkbox',
              checked: Boolean(picked[candidate.index]),
              onChange: (event) => setPicked({ ...picked, [candidate.index]: event.target.checked }),
            }),
            h('span', { className: 'cm-id' }, `#${candidate.index + 1}`),
            h('span', { className: 'cm-preview' }, candidate.preview),
            h(Chip, { tone: STATUS_TONE[candidate.item.status] ?? 'muted' }, STATUS_LABEL[candidate.item.status] ?? candidate.item.status),
            )),
          ),
        ) : null,
      )
    }

    function ItemDetail(props) {
      const { item, type } = props
      const [busy, setBusy] = useState(false)
      const [draft, setDraft] = useState(null)
      const [confirming, setConfirming] = useState(false)

      const FIELD_LABEL = {
        stem: '题干', options: '选项', answer: '答案', explanation: '解析', point: '语法点',
        passage: '文章正文', title: '标题', text: '原文', ref: '参考译文',
        topic: '题材', difficulty: '难度',
      }

      const setStatus = async (status) => {
        setBusy(true)
        try {
          await call('bank.status', { type, id: item.id, status })
          props.toast(`已标为「${STATUS_LABEL[status]}」`)
          props.onChanged()
        } catch (error) {
          props.toast(error.message, 'error')
        } finally {
          setBusy(false)
        }
      }
      const remove = async () => {
        setBusy(true)
        try {
          await call('bank.delete', { type, id: item.id })
          props.toast('已删除')
          props.onClose()
          props.onChanged()
        } catch (error) {
          props.toast(error.message, 'error')
        } finally {
          setBusy(false)
        }
      }

      const beginEdit = () => setDraft({
        stem: item.stem ?? '',
        options: [...(item.options ?? ['', '', '', ''])],
        answer: item.answer ?? '',
        explanation: item.explanation ?? '',
        point: item.point ?? '',
        passage: item.passage ?? '',
        title: item.title ?? '',
        text: item.text ?? '',
        ref: item.ref ?? '',
        topic: item.topic ?? '',
        difficulty: item.difficulty ?? 'L3',
      })

      /** 只把真的改过的字段挑出来，确认框里逐条列给人看。 */
      const changedFields = () => {
        if (!draft) return []
        const out = []
        const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
        for (const key of Object.keys(draft)) {
          const before = item[key] ?? (key === 'options' ? [] : '')
          if (!same(draft[key], before)) out.push(key)
        }
        return out
      }

      const save = async () => {
        const keys = changedFields()
        if (keys.length === 0) {
          props.toast('没有改动')
          setDraft(null)
          return
        }
        const patch = {}
        for (const key of keys) patch[key] = draft[key]
        setBusy(true)
        try {
          await call('bank.update', { type, id: item.id, patch })
          props.toast(`已保存 ${keys.length} 处修改`)
          setConfirming(false)
          setDraft(null)
          props.onChanged()
        } catch (error) {
          props.toast(error.message, 'error')
        } finally {
          setBusy(false)
        }
      }

      const field = (key, label, element) => h('div', { style: { marginBottom: 10 } },
        h(Field, { label }, element))

      const renderForm = () => h('div', null,
        item.type === 'reading'
          ? h('div', null,
            field('title', '标题', h('input', { className: 'cm-input', value: draft.title, onChange: (event) => setDraft({ ...draft, title: event.target.value }) })),
            field('passage', '文章正文', h('textarea', { className: 'cm-area', style: { minHeight: 220 }, value: draft.passage, onChange: (event) => setDraft({ ...draft, passage: event.target.value }) })),
            h('p', { className: 'cm-hint' }, `小题（${item.questions?.length ?? 0} 道）不在这里改；要改小题用 catti_bank update 传 questions，或直接改题库 JSON。`),
          )
          : item.type === 'ja2zh' || item.type === 'zh2ja'
            ? h('div', null,
              field('title', '标题', h('input', { className: 'cm-input', value: draft.title, onChange: (event) => setDraft({ ...draft, title: event.target.value }) })),
              field('text', '原文', h('textarea', { className: 'cm-area', style: { minHeight: 200 }, value: draft.text, onChange: (event) => setDraft({ ...draft, text: event.target.value }) })),
              field('ref', '参考译文', h('textarea', { className: 'cm-area', style: { minHeight: 160 }, value: draft.ref, onChange: (event) => setDraft({ ...draft, ref: event.target.value }) })),
            )
            : h('div', null,
              field('stem', '题干', h('textarea', { className: 'cm-area', style: { minHeight: 90 }, value: draft.stem, onChange: (event) => setDraft({ ...draft, stem: event.target.value }) })),
              h('div', null, ['A', 'B', 'C', 'D'].map((letter, index) => field(`options${index}`, `选项 ${letter}`,
                h('input', {
                  className: 'cm-input',
                  value: draft.options[index] ?? '',
                  onChange: (event) => {
                    const next = [...draft.options]
                    next[index] = event.target.value
                    setDraft({ ...draft, options: next })
                  },
                })))),
              h('div', { className: 'cm-row', style: { gap: 12, alignItems: 'flex-end' } },
                h('div', { style: { width: 120 } }, field('answer', '答案', h(Select, {
                  value: draft.answer,
                  onChange: (value) => setDraft({ ...draft, answer: value }),
                  options: ['', 'A', 'B', 'C', 'D'].map((letter) => ({ value: letter, label: letter || '未设' })),
                }))),
                h('div', { style: { flex: '1 1 200px' } }, field('point', '语法点（语法题）', h('input', {
                  className: 'cm-input',
                  value: draft.point,
                  onChange: (event) => setDraft({ ...draft, point: event.target.value }),
                }))),
              ),
              field('explanation', '解析', h('textarea', { className: 'cm-area', style: { minHeight: 110 }, value: draft.explanation, onChange: (event) => setDraft({ ...draft, explanation: event.target.value }) })),
            ),
        h('div', { className: 'cm-row', style: { gap: 12 } },
          h('div', { style: { width: 160 } }, field('topic', '题材', h('input', {
            className: 'cm-input', value: draft.topic, placeholder: '经济/政法/社科/科技/文化/生活',
            onChange: (event) => setDraft({ ...draft, topic: event.target.value }),
          }))),
          h('div', { style: { width: 120 } }, field('difficulty', '难度', h(Select, {
            value: draft.difficulty, onChange: (value) => setDraft({ ...draft, difficulty: value }),
            options: ['L1', 'L2', 'L3'].map((value) => ({ value, label: value })),
          }))),
        ),
        h('div', { className: 'cm-row', style: { marginTop: 6 } },
          h(Btn, { kind: 'primary', onClick: () => setConfirming(true), disabled: busy }, '保存修改…'),
          h(Btn, { onClick: () => setDraft(null), disabled: busy }, '取消'),
          h('span', { className: 'cm-hint' }, '保存前会再确认一次。'),
        ),
      )

      const changed = changedFields()

      return h('div', { className: 'cm-card cm-scroll-detail' },
        h('div', { className: 'cm-row', style: { justifyContent: 'space-between' } },
          h('div', { className: 'cm-row' },
            h(Btn, { size: 'sm', onClick: props.onClose }, '← 返回列表'),
            h('h3', { className: 'cm-card-title', style: { margin: 0 } }, `${item.id} · ${TYPE_LABEL[type]?.zh ?? type}`),
            item.level === '3' ? h(Chip, null, '三笔') : item.level === '2' ? h(Chip, null, '二笔') : null,
            item.exam_kind === 'real' ? h(Chip, { tone: 'ok' }, `真题${item.year ? ' ' + item.year : ''}`) : null,
            item.exam_kind === 'mock' ? h(Chip, { tone: 'warn' }, '模拟') : null,
          ),
          h('div', { className: 'cm-row' },
            h(Chip, { tone: STATUS_TONE[item.status] ?? 'muted' }, STATUS_LABEL[item.status] ?? item.status),
            h(Chip, null, item.difficulty),
            item.type === 'ja2zh' || item.type === 'zh2ja'
              ? h(Chip, { tone: item.full_text === false ? 'warn' : 'ok' }, item.full_text === false ? '小段 · 不进实务卷' : '整篇')
              : null,
            item.answer_src === 'ai_solved' ? h(Chip, { tone: 'warn' }, `AI 答案·${item.confidence}`) : null,
            draft
              ? null
              : h(Btn, { size: 'sm', onClick: beginEdit, disabled: busy }, '编辑'),
          ),
        ),
        h('div', { className: 'cm-spacer' }),
        draft ? renderForm() : h('div', null,
          item.type === 'reading' ? h('div', null,
            h('p', { className: 'cm-passage' }, item.passage),
            (item.questions ?? []).map((question, index) => h('div', { key: index, className: 'cm-q-block' },
              h('p', { className: 'cm-stem' }, `${index + 1}. ${question.stem}`),
              h('div', { className: 'cm-options' }, question.options.map((option, optionIndex) => h('div', {
                key: optionIndex,
                className: `cm-option${String.fromCharCode(65 + optionIndex) === question.answer ? ' is-on' : ''}`,
              }, h('span', { className: 'cm-option-key' }, String.fromCharCode(65 + optionIndex)), h('span', null, option)))),
              h('p', { className: 'cm-hint', style: { marginTop: 6 } }, `答案 ${question.answer || '—'}${question.explanation ? ` · ${question.explanation}` : ''}`),
            )),
          ) : item.type === 'ja2zh' || item.type === 'zh2ja' ? h('div', null,
            h('p', { className: 'cm-stem' }, item.text),
            h('p', { className: 'cm-hint' }, `参考译文（${item.ref_src === 'ai_solved' ? 'AI 补的，只展示不评分' : item.ref_src === 'official' ? '来源给定' : '无'}）：`),
            h('p', { className: 'cm-stem', style: { color: 'var(--dsw-alias-label-secondary)' } }, item.ref || '（没有参考译文）'),
            h('p', { className: 'cm-hint' }, `${item.chars} 字 · 采分点 ${item.rubric?.length ?? 0} 个`),
          ) : h('div', null,
            h('p', { className: 'cm-stem' }, item.stem),
            h('div', { className: 'cm-options' }, (item.options ?? []).map((option, index) => h('div', {
              key: index,
              className: `cm-option${String.fromCharCode(65 + index) === item.answer ? ' is-on' : ''}`,
            }, h('span', { className: 'cm-option-key' }, String.fromCharCode(65 + index)), h('span', null, option)))),
            item.point ? h('p', { className: 'cm-hint' }, `语法点：${item.point}`) : null,
            item.explanation ? h('p', { className: 'cm-hint' }, `解析：${item.explanation}`) : null,
            item.answer_reason ? h('p', { className: 'cm-hint' }, `AI 解题思路：${item.answer_reason}`) : null,
          ),
          h('dl', { className: 'cm-kv', style: { marginTop: 12 } },
            h('dt', null, '来源'), h('dd', null, item.source || '—'),
            h('dt', null, '题材'), h('dd', null, item.topic || '—'),
            h('dt', null, '标签'), h('dd', null, (item.tags ?? []).join('、') || '—'),
            h('dt', null, '批次'), h('dd', null, item.audit_batch || '—'),
          ),
        ),
        draft ? null : h('div', { className: 'cm-row', style: { marginTop: 14 } },
          h(Btn, { kind: 'primary', size: 'sm', disabled: busy || item.status === 'active', onClick: () => setStatus('active') }, '通过'),
          h(Btn, { size: 'sm', disabled: busy, onClick: () => setStatus('disputed') }, '标争议'),
          h(Btn, { size: 'sm', disabled: busy, onClick: () => setStatus('needs_human') }, '转人工'),
          h(Btn, { size: 'sm', disabled: busy, onClick: () => setStatus('rejected') }, '拒绝'),
          h('span', { style: { marginLeft: 'auto' } }, h(Btn, { kind: 'danger', size: 'sm', disabled: busy, onClick: remove }, '删除')),
        ),
        confirming ? h(Modal, {
          title: `确认修改 ${item.id}？`,
          onClose: () => setConfirming(false),
          footer: [
            h(Btn, { key: 'cancel', onClick: () => setConfirming(false) }, '不改了'),
            h(Btn, { key: 'ok', kind: 'primary', onClick: save, disabled: busy }, '确认保存'),
          ],
        },
        h('div', null,
          h('p', { className: 'cm-hint' }, '会改动题库文件，保存后立即生效。改的是这些字段：'),
          h('ul', { style: { margin: '6px 0 0 18px', padding: 0 } },
            changed.map((key) => h('li', { key, className: 'cm-hint' }, FIELD_LABEL[key] ?? key))),
          changed.length === 0 ? h('p', { className: 'cm-hint' }, '（没有改动）') : null,
        ),
        ) : null,
      )
    }

    const BANK_PAGE_SIZE = 100

    function BankView(props) {
      const [type, setType] = useState('vocab')
      const [status, setStatus] = useState('all')
      const [examKind, setExamKind] = useState('all')
      const [levelFilter, setLevelFilter] = useState('all')
      const [page, setPage] = useState(0)
      const [wrongOnly, setWrongOnly] = useState(false)
      const [query, setQuery] = useState('')
      const [list, setList] = useState(null)
      const [detail, setDetail] = useState(null)
      const [busy, setBusy] = useState(false)
      const [showImport, setShowImport] = useState(false)

      const load = useCallback(async () => {
        setBusy(true)
        try {
          const result = await call('bank.list', {
            type,
            status: status === 'all' ? 'all' : status,
            exam_kind: examKind,
            level: levelFilter,
            wrong_only: wrongOnly,
            q: query,
            offset: page * BANK_PAGE_SIZE,
            limit: BANK_PAGE_SIZE,
          })
          setList(result)
        } catch (error) {
          props.toast(error.message, 'error')
        } finally {
          setBusy(false)
        }
      }, [type, status, examKind, levelFilter, wrongOnly, query, page])

      useEffect(() => { setPage(0) }, [type, status, examKind, levelFilter, wrongOnly, query])
      useEffect(() => { void load() }, [load])

      const openItem = async (id) => {
        try {
          const result = await call('bank.get', { type, id })
          setDetail(result.item)
        } catch (error) {
          props.toast(error.message, 'error')
        }
      }

      const counts = props.state?.types ?? {}
      return h('div', { className: 'cm-grid cm-grid-side' },
        h('div', null,
          h('div', { className: 'cm-card', style: { padding: 8 } },
            h('div', { className: 'cm-bank-nav' }, TYPES.map(([key, zh]) => h('button', {
              key,
              type: 'button',
              className: `cm-bank-item${type === key ? ' is-on' : ''}`,
              onClick: () => { setType(key); setDetail(null) },
            },
            h('span', null, zh),
            h('span', { className: 'cm-muted', style: { fontSize: 11 } }, `${counts[key]?.active ?? 0}/${counts[key]?.total ?? 0}`),
            ))),
          ),
          h('div', { className: 'cm-card', style: { marginTop: 12 } },
            h('p', { className: 'cm-hint' }, '在库/总数 是「可组卷」与「库内全部」。候选与待人工不参与组卷。'),
            h('div', { className: 'cm-spacer' }),
            h(Btn, { size: 'sm', onClick: () => setShowImport(!showImport) }, showImport ? '收起导入' : '导入题目'),
          ),
        ),
        h('div', null,
          showImport ? h(ImportPanel, { toast: props.toast, onChanged: () => { void load(); props.refresh() } }) : null,
          detail ? h(ItemDetail, {
            item: detail,
            type,
            toast: props.toast,
            onClose: () => setDetail(null),
            onChanged: () => { setDetail(null); void load(); props.refresh() },
          }) : null,
          h('div', { className: 'cm-card' },
            h('div', { className: 'cm-row', style: { marginBottom: 10 } },
              h('div', { style: { flex: '1 1 220px' } }, h('input', {
                className: 'cm-input',
                value: query,
                placeholder: '搜索题干、来源、标签',
                onChange: (event) => setQuery(event.target.value),
              })),
              h('div', { style: { width: 120 } }, h(Select, {
                value: status,
                onChange: setStatus,
                options: [
                  { value: 'all', label: '全部状态' },
                  { value: 'active', label: '在库' },
                  { value: 'candidate', label: '候选' },
                  { value: 'needs_human', label: '待人工' },
                  { value: 'disputed', label: '争议' },
                  { value: 'rejected', label: '已拒' },
                ],
              })),
              h('div', { style: { width: 96 } }, h(Select, {
                value: levelFilter,
                onChange: setLevelFilter,
                options: [
                  { value: 'all', label: '二/三笔' },
                  { value: '2', label: '二笔' },
                  { value: '3', label: '三笔' },
                ],
              })),
              h('div', { style: { width: 112 } }, h(Select, {
                value: examKind,
                onChange: setExamKind,
                options: [
                  { value: 'all', label: '真题 / 模拟' },
                  { value: 'real', label: '只看真题' },
                  { value: 'mock', label: '只看模拟' },
                  { value: 'textbook', label: '只看教材' },
                ],
              })),
              h(Btn, {
                size: 'sm',
                kind: wrongOnly ? 'primary' : 'default',
                onClick: () => setWrongOnly(!wrongOnly),
                title: '只看做错过的题',
              }, wrongOnly ? '只看错题 ✓' : '只看错题'),
              h(Btn, { size: 'sm', onClick: load, disabled: busy }, '刷新'),
              h('span', { className: 'cm-hint', style: { marginLeft: 'auto' } }, list ? `${list.total} 条` : ''),
            ),
            !list || list.items.length === 0 ? null : (() => {
              const total = list.total ?? 0
              const totalPages = Math.max(1, Math.ceil(total / BANK_PAGE_SIZE))
              return h('div', { className: 'cm-row', style: { marginTop: 10, justifyContent: 'space-between' } },
                h('span', { className: 'cm-hint' }, `第 ${page + 1} / ${totalPages} 页 · 共 ${total} 条（每页 ${BANK_PAGE_SIZE}）`),
                h('div', { className: 'cm-row' },
                  h(Btn, { size: 'sm', disabled: busy || page === 0, onClick: () => setPage(0) }, '首页'),
                  h(Btn, { size: 'sm', disabled: busy || page === 0, onClick: () => setPage(page - 1) }, '上一页'),
                  h(Btn, { size: 'sm', disabled: busy || page >= totalPages - 1, onClick: () => setPage(page + 1) }, '下一页'),
                  h(Btn, { size: 'sm', disabled: busy || page >= totalPages - 1, onClick: () => setPage(totalPages - 1) }, '末页'),
                ),
              )
            })(),            !list ? h(Empty, null, '读取中…')
              : list.items.length === 0 ? h(Empty, null, '这个筛选下没有题。')
              : h('div', { className: 'cm-list cm-scroll' }, list.items.map((item) => h('div', {
                key: item.id,
                className: `cm-rowitem${detail?.id === item.id ? ' is-on' : ''}`,
                onClick: () => openItem(item.id),
              },
              h('span', { className: 'cm-id' }, item.id),
              h('span', { className: 'cm-preview', title: item.preview }, item.preview),
              h('span', { className: 'cm-meta' },
                item.hasAnswer ? null : h(Chip, { tone: 'warn' }, (item.type === 'ja2zh' || item.type === 'zh2ja') ? '无参考译文' : '无答案'),
                item.level === '3' ? h(Chip, null, '三笔') : item.level === '2' ? h(Chip, null, '二笔') : null,
                item.exam_kind === 'real' ? h(Chip, { tone: 'ok' }, item.year ? `${item.year} 真题` : '真题') : null,
                item.exam_kind === 'mock' ? h(Chip, { tone: 'warn' }, '模拟') : null,
                item.answer_src === 'ai_solved' ? h(Chip, { tone: 'warn' }, 'AI 答案') : null,
                h(Chip, null, item.difficulty),
                h(Chip, { tone: STATUS_TONE[item.status] ?? 'muted' }, STATUS_LABEL[item.status] ?? item.status),
              ),
              ))),

          ),
        ),
      )
    }

    // ------------------------------------------------------------------ 组卷

    const FREE_DEFAULTS = {
      vocab: { on: true, count: 10, points: 20 },
      grammar: { on: true, count: 40, points: 40 },
      reading: { on: true, count: 25, points: 40 },
      ja2zh: { on: false, count: 3, points: 50 },
      zh2ja: { on: false, count: 3, points: 50 },
    }

    function PaperView(props) {
      const [mode, setMode] = useState('template')
      const [blueprints, setBlueprints] = useState([])
      const [blueprintId, setBlueprintId] = useState('catti2-comprehensive')
      const [free, setFree] = useState(FREE_DEFAULTS)
      const [difficulty, setDifficulty] = useState('all')
      const [source, setSource] = useState('all')
      const [title, setTitle] = useState('')
      const [duration, setDuration] = useState(180)
      const [preview, setPreview] = useState(null)
      const [papers, setPapers] = useState([])
      const [seed, setSeed] = useState(() => Math.floor(Math.random() * 1e9))
      const [busy, setBusy] = useState(false)
      const [yearPick, setYearPick] = useState('2014-real')
      const [wrongOnly, setWrongOnly] = useState(false)

      const load = useCallback(async () => {
        try {
          const [blue, list] = await Promise.all([call('paper.blueprints'), call('paper.list')])
          setBlueprints(blue)
          setPapers(list.papers)
        } catch (error) {
          props.toast(error.message, 'error')
        }
      }, [])
      useEffect(() => { void load() }, [load])

      // 选了哪个模板，时长就跟着模板走；不再出现「卡片写 120、输入框是 180」。
      useEffect(() => {
        const blueprint = blueprints.find((entry) => entry.id === blueprintId)
        if (blueprint) setDuration(blueprint.duration_min)
      }, [blueprintId, blueprints])

      const selectedBlueprint = blueprints.find((entry) => entry.id === blueprintId) ?? null
      const templateShort = mode === 'template' && selectedBlueprint
        ? selectedBlueprint.sections.filter((section) => section.available < section.count)
        : []
      const canBuild = !(mode === 'template' && templateShort.length > 0)

      const sectionsPayload = () => TYPES
        .filter(([key]) => free[key]?.on)
        .map(([key]) => ({
          type: key,
          count: Number(free[key].count) || 0,
          points: Number(free[key].points) || 0,
          chars: key === 'ja2zh' ? [1500, 1700] : key === 'zh2ja' ? [750, 850] : undefined,
        }))

      const compose = async () => {
        setBusy(true)
        try {
          const result = await call('paper.compose', {
            mode,
            blueprintId,
            sections: sectionsPayload(),
            title: title || undefined,
            duration_min: Number(duration) || undefined,
            seed,
            constraints: { difficulty: difficulty === 'all' ? [] : [difficulty], source: source === 'all' ? '' : source, wrongOnly },
          })
          setPreview(result)
          if (result.shortfalls.length > 0) {
            props.toast('题量不够：' + result.shortfalls.map((item) => `${TYPE_LABEL[item.type]?.zh ?? item.type} 需 ${item.need} 只有 ${item.have}`).join('，'), 'error')
          }
        } catch (error) {
          props.toast(error.message, 'error')
        } finally {
          setBusy(false)
        }
      }

      const create = async (startAfter) => {
        setBusy(true)
        try {
          const result = await call('paper.create', {
            mode,
            blueprintId,
            sections: sectionsPayload(),
            title: title || undefined,
            duration_min: Number(duration) || undefined,
            seed,
            constraints: { difficulty: difficulty === 'all' ? [] : [difficulty], source: source === 'all' ? '' : source, wrongOnly },
          })
          props.toast(`已建卷 ${result.paper.id}，在下面点「开始」才会计时`)
          setPreview(null)
          await load()
          if (startAfter) {
            const started = await call('exam.start', { paperId: result.paper.id })
            props.toast(`考试开始：${started.exam.paper_title}`)
            props.onExamStarted()
          }
        } catch (error) {
          props.toast(error.message, 'error')
        } finally {
          setBusy(false)
        }
      }

      const startPaper = async (paper) => {
        const detail = `${paper.title} · ${paper.duration_min} 分钟 · ${paper.total_points} 分 · `
          + paper.sections.map((section) => `${TYPE_LABEL[section.type]?.zh ?? section.type} ${section.count}`).join(' / ')
        if (!window.confirm(`现在开始考试？\n\n${detail}\n\n点确定后开始计时；中途可以暂停，关掉页面也会继续计时。`)) return
        setBusy(true)
        try {
          const started = await call('exam.start', { paperId: paper.id })
          props.toast(`考试开始：${started.exam.paper_title}`)
          props.onExamStarted()
        } catch (error) {
          props.toast(error.message, 'error')
        } finally {
          setBusy(false)
        }
      }

      const removePaper = async (paperId) => {
        if (!window.confirm(`删除试卷 ${paperId}？试卷文件会被删掉，已经交卷的成绩单不受影响。`)) return
        setBusy(true)
        try {
          await call('paper.delete', { paperId })
          props.toast('已删除试卷')
          await load()
        } catch (error) {
          props.toast(error.message, 'error')
        } finally {
          setBusy(false)
        }
      }

      const buildYearPaper = async () => {
        const [yearPart, kindPart] = yearPick.split('-')
        setBusy(true)
        try {
          const result = await call('paper.from_year', {
            year: yearPart === 'mock' ? null : Number(yearPart),
            examKind: kindPart,
          })
          props.toast(`已建套卷 ${result.paper.id}：${result.paper.total_points} 分 / ${result.paper.duration_min} 分钟`)
          await load()
        } catch (error) {
          props.toast(error.message, 'error')
        } finally {
          setBusy(false)
        }
      }

      const updateFree = (key, patch) => setFree({ ...free, [key]: { ...free[key], ...patch } })

      return h('div', null,
        h('div', { className: 'cm-card' },
          h('h3', { className: 'cm-card-title' }, '组卷'),
          h('div', { className: 'cm-row', style: { marginBottom: 12 } },
            h(Btn, { kind: mode === 'template' ? 'primary' : undefined, size: 'sm', onClick: () => setMode('template') }, '模板组卷'),
            h(Btn, { kind: mode === 'free' ? 'primary' : undefined, size: 'sm', onClick: () => setMode('free') }, '自由组卷'),
            h('span', { className: 'cm-hint', style: { marginLeft: 'auto' } }, '预览与建卷用同一个 seed，看到什么就考什么'),
          ),
          mode === 'template' ? h('div', { className: 'cm-grid cm-grid-2' },
            blueprints.map((blueprint) => h('div', {
              key: blueprint.id,
              className: 'cm-card',
              style: {
                borderColor: blueprintId === blueprint.id ? 'var(--dsw-alias-brand-primary)' : undefined,
                cursor: 'pointer',
                background: 'var(--dsw-alias-bg-base)',
              },
              onClick: () => { setBlueprintId(blueprint.id); setDuration(blueprint.duration_min) },
            },
            h('strong', null, blueprint.title),
            h('p', { className: 'cm-hint' }, `${blueprint.duration_min} 分钟 · 总分 ${blueprint.sections.reduce((sum, section) => sum + section.points, 0)}`),
            h('div', { className: 'cm-row', style: { marginTop: 8 } },
              blueprint.sections.map((section) => h(Chip, {
                key: section.type,
                tone: section.available >= section.count ? 'ok' : 'warn',
              }, `${TYPE_LABEL[section.type]?.zh ?? section.type} ${section.count}（可抽 ${section.available}）`)),
            ),
            )),
          ) : h('div', null,
            TYPES.map(([key, zh]) => h('div', { key, className: 'cm-row', style: { padding: '6px 0', borderBottom: '1px solid var(--dsw-alias-border-l1)' } },
              h('label', { className: 'cm-row', style: { width: 130, cursor: 'pointer' } },
                h('input', { type: 'checkbox', checked: Boolean(free[key]?.on), onChange: (event) => updateFree(key, { on: event.target.checked }) }),
                h('span', null, zh),
              ),
              h('div', { style: { width: 110 } }, h(Field, { label: '数量' }, h('input', {
                className: 'cm-input', type: 'number', min: 0, value: free[key]?.count ?? 0,
                onChange: (event) => updateFree(key, { count: Number(event.target.value) }),
              }))),
              h('div', { style: { width: 110 } }, h(Field, { label: '分值' }, h('input', {
                className: 'cm-input', type: 'number', min: 0, value: free[key]?.points ?? 0,
                onChange: (event) => updateFree(key, { points: Number(event.target.value) }),
              }))),
              key === 'ja2zh' ? h('span', { className: 'cm-hint' }, '只收整篇；预算 1500–1700 字') : null,
              key === 'zh2ja' ? h('span', { className: 'cm-hint' }, '只收整篇；预算 750–850 字') : null,
            )),
          ),
          h('div', { className: 'cm-row', style: { marginTop: 14 } },
            h('div', { style: { width: 150 } }, h(Field, { label: '难度' }, h(Select, {
              value: difficulty, onChange: setDifficulty,
              options: [{ value: 'all', label: '不限' }, { value: 'L1', label: 'L1' }, { value: 'L2', label: 'L2' }, { value: 'L3', label: 'L3' }],
            }))),
            h('div', { style: { width: 150 } }, h(Field, { label: '来源' }, h(Select, {
              value: source, onChange: setSource,
              options: [{ value: 'all', label: '不限' }, { value: 'real', label: '真题' }, { value: 'mock', label: '模拟' }, { value: 'textbook', label: '教材' }, { value: 'manual', label: '手工录入' }],
            }))),
            h('div', { style: { width: 120 } }, h(Field, { label: '错题库' }, h(Btn, {
              size: 'sm',
              kind: wrongOnly ? 'primary' : 'default',
              onClick: () => setWrongOnly(!wrongOnly),
              title: '只从做错过的题里抽',
            }, wrongOnly ? '只抽错题 ✓' : '只抽错题'))),
            h('div', { style: { flex: '1 1 200px' } }, h(Field, { label: '试卷名（可空）' }, h('input', {
              className: 'cm-input', value: title, onChange: (event) => setTitle(event.target.value), placeholder: '如 2026 冲刺 · 第三套',
            }))),
            h('div', { style: { width: 110 } }, h(Field, { label: '时长（分钟）' }, h('input', {
              className: 'cm-input', type: 'number', min: 10, value: duration, onChange: (event) => setDuration(Number(event.target.value)),
            }))),
            h('div', { className: 'cm-row', style: { alignItems: 'flex-end' } },
              h(Btn, { onClick: compose, disabled: busy }, '预览'),
              h(Btn, {
                kind: 'primary',
                onClick: () => create(false),
                disabled: busy || !canBuild,
                title: canBuild ? '只建卷，不会开始计时' : '题量不足，先补题库',
              }, '建卷'),
            ),
          ),
          templateShort.length > 0
            ? h('div', { className: 'cm-warn' },
              '题量不足，建卷已禁用：'
              + templateShort.map((section) => `${TYPE_LABEL[section.type]?.zh ?? section.type} 需 ${section.count}，现有 ${section.available}`).join('；')
              + '。去「题库」导入或放行候选题。')
            : null,
        ),
        preview ? h('div', { className: 'cm-card' },
          h('h3', { className: 'cm-card-title' }, `预览 · ${preview.blueprint.title} · ${preview.duration_min} 分钟 · ${preview.total_points} 分`),
          preview.preview.map((section) => h('div', { key: section.type, style: { marginBottom: 12 } },
            h('div', { className: 'cm-row' },
              h('strong', null, section.label),
              h('span', { className: 'cm-hint' }, `${section.count} 题 · ${section.chars || 0} 字 · ${section.points} 分`),
            ),
            section.items.length === 0 ? h('p', { className: 'cm-error-list' }, '这一段没抽到题') : h('div', { className: 'cm-list cm-scroll-sm', style: { marginTop: 4 } },
              section.items.map((item) => h('div', { key: item.id, className: 'cm-rowitem', style: { gridTemplateColumns: '86px minmax(0,1fr) auto', cursor: 'default' } },
                h('span', { className: 'cm-id' }, item.id),
                h('span', { className: 'cm-preview' }, item.preview),
                h('span', { className: 'cm-hint' }, item.composed_of ? `拼段 ${item.composed_of.length}` : `${item.chars} 字`),
              )),
            ),
          )),
          preview.warnings.map((warning, index) => h('div', { key: index, className: 'cm-warn' }, warning)),
          preview.shortfalls.length > 0 ? h('div', null,
            h('p', { className: 'cm-error-list' }, '题量不够，建卷会被拒绝（也可以勾「允许不足」）。'),
            preview.shortfalls.map((item) => h('div', { key: item.type, className: 'cm-warn' }, `${TYPE_LABEL[item.type]?.zh ?? item.type}：需要 ${item.need}，只有 ${item.have} —— ${item.reason}`)),
          ) : null,
          h('div', { className: 'cm-row', style: { marginTop: 10 } },
            h(Btn, { kind: 'primary', onClick: () => create(false), disabled: busy }, '按预览建卷'),
            h(Btn, { onClick: () => { setSeed(Math.floor(Math.random() * 1e9)); setPreview(null) } }, '换一批'),
          ),
        ) : null,
        h('div', { className: 'cm-card' },
          h('h3', { className: 'cm-card-title' }, '按年份建套卷'),
          h('p', { className: 'cm-hint' },
            '把某一年的题按当年卷面装成一份试卷：综合 100 分（词汇/语法/阅读）+ 实务 100 分（日译中 40、中译日 60），300 分钟。只收在库的题，建好就进下面的试卷列表。'),
          h('div', { className: 'cm-row', style: { marginTop: 10 } },
            h('div', { style: { width: 220 } }, h(Select, {
              value: yearPick,
              onChange: setYearPick,
              options: [
                ...['2014', '2015', '2016', '2017', '2018'].map((year) => ({ value: `${year}-real`, label: `${year} 真题 · 全卷` })),
                { value: 'mock-mock', label: '综合能力模拟试题 · 全卷' },
              ],
            })),
            h(Btn, { kind: 'primary', onClick: buildYearPaper, disabled: busy }, '建套卷'),
          ),
        ),
        h('div', { className: 'cm-card' },
          h('h3', { className: 'cm-card-title' }, `已保存的试卷（${papers.length}）`),
          papers.length === 0 ? h(Empty, null, '还没有试卷。上面选一个模板或自由组卷。') : h('div', { className: 'cm-list' },
            papers.map((paper) => h('div', { key: paper.id, className: 'cm-rowitem', style: { gridTemplateColumns: '150px minmax(0,1fr) auto', cursor: 'default' } },
              h('span', { className: 'cm-id' }, paper.id),
              h('div', null,
                h('div', null, paper.title),
                h('div', { className: 'cm-meta', style: { marginTop: 2 } },
                  paper.exam_kind === 'real' ? h(Chip, { tone: 'ok' }, paper.year ? `真题 ${paper.year}` : '真题') : null,
                  paper.exam_kind === 'mock' ? h(Chip, { tone: 'warn' }, '模拟') : null,
                  h(Chip, null, `${paper.total_points} 分`),
                ),
                h('div', { className: 'cm-hint' }, `${paper.duration_min} 分钟 · ${paper.created_at ? formatTime(paper.created_at).slice(0, 10) : ''} · ${paper.sections.map((section) => `${TYPE_LABEL[section.type]?.zh ?? section.type} ${section.count}`).join(' / ')}`),
              ),
              h('div', { className: 'cm-row' },
                h(Btn, { size: 'sm', kind: 'primary', disabled: busy, onClick: () => startPaper(paper) }, '开始'),
                h(Btn, { size: 'sm', kind: 'danger', disabled: busy, onClick: () => removePaper(paper.id) }, '删除'),
              ),
            )),
          ),
        ),
      )
    }

    // ------------------------------------------------------------------ 考试

    function ExamView(props) {
      const [exam, setExam] = useState(null)
      const [paper, setPaper] = useState(null)
      const [answers, setAnswers] = useState({})
      const [papers, setPapers] = useState([])
      const [now, setNow] = useState(Date.now())
      const [syncAt, setSyncAt] = useState(Date.now())
      const [remainingAtSync, setRemainingAtSync] = useState(0)
      const [busy, setBusy] = useState(false)
      const [confirmSubmit, setConfirmSubmit] = useState(false)
      const [savedAt, setSavedAt] = useState(0)
      const [saveError, setSaveError] = useState('')
      const [loading, setLoading] = useState(true)
      const timers = useRef({})
      const currentRef = useRef('')

      const apply = (result) => {
        if (!result) return
        if (result.report) {
          props.onReport(result.report.id)
          return
        }
        setExam(result.exam)
        setPaper(result.paper)
        setAnswers(result.exam?.answers ?? {})
        setSyncAt(Date.now())
        setRemainingAtSync(result.exam?.remaining_ms ?? 0)
      }

      const sync = useCallback(async () => {
        try {
          const result = await call('exam.state', { examId: props.examId || undefined })
          setLoading(false)
          apply(result)
        } catch (error) {
          setLoading(false)
          props.toast(error.message, 'error')
        }
      }, [props.examId])

      useEffect(() => {
        void sync()
        const list = call('paper.list').then((result) => setPapers(result.papers)).catch(() => {})
        return () => { void list }
      }, [sync])

      useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), 1000)
        return () => clearInterval(timer)
      }, [])

      useEffect(() => {
        const timer = setInterval(() => { void sync() }, 15000)
        return () => clearInterval(timer)
      }, [sync])

      const remaining = exam && exam.status === 'running'
        ? Math.max(0, remainingAtSync - (now - syncAt))
        : remainingAtSync

      useEffect(() => {
        if (exam && exam.status === 'running' && remaining <= 0) {
          void sync()
        }
      }, [remaining, exam?.status, sync])

      const save = (key, value) => {
        setAnswers((previous) => ({ ...previous, [key]: value }))
        if (!exam) return
        clearTimeout(timers.current[key])
        timers.current[key] = setTimeout(() => {
          call('exam.answer', { examId: exam.id, key, value })
            .then(() => {
              setSaveError('')
              setSavedAt(Date.now())
            })
            .catch((error) => {
              setSaveError(error.message)
              props.toast('答案没存上：' + error.message, 'error')
            })
        }, key.split(':').length > 2 ? 400 : 200)
      }

      const pause = async () => {
        setBusy(true)
        try {
          await call('exam.pause', { examId: exam.id })
          await sync()
          props.toast('已暂停，答题区只读')
        } catch (error) {
          props.toast(error.message, 'error')
        } finally {
          setBusy(false)
        }
      }
      const resume = async () => {
        setBusy(true)
        try {
          await call('exam.resume', { examId: exam.id })
          await sync()
          props.toast('已恢复')
        } catch (error) {
          props.toast(error.message, 'error')
        } finally {
          setBusy(false)
        }
      }
      const submit = async () => {
        setBusy(true)
        try {
          const result = await call('exam.submit', { examId: exam.id })
          setConfirmSubmit(false)
          if (result.report) props.onReport(result.report.id)
          else props.toast('已交卷')
        } catch (error) {
          props.toast(error.message, 'error')
        } finally {
          setBusy(false)
        }
      }
      const start = async (paper) => {
        const detail = `${paper.title} · ${paper.duration_min} 分钟 · ${paper.total_points} 分`
        if (!window.confirm(`现在开始考试？\n\n${detail}\n\n点确定后开始计时；中途可以暂停，关掉页面也会继续计时。`)) return
        setBusy(true)
        try {
          const result = await call('exam.start', { paperId: paper.id })
          apply({ exam: result.exam, paper: result.paper, report: null })
          props.onRefreshState()
        } catch (error) {
          props.toast(error.message, 'error')
        } finally {
          setBusy(false)
        }
      }

      if (loading) return h('div', { className: 'cm-card' }, h(Empty, null, '读取考试状态…'))

      if (!exam) {
        return h('div', { className: 'cm-card' },
          h('h3', { className: 'cm-card-title' }, '开始一场考试'),
          papers.length === 0 ? h(Empty, null, '还没有试卷。先去「组卷」建一份。') : h('div', { className: 'cm-list' },
            papers.map((item) => h('div', { key: item.id, className: 'cm-rowitem', style: { gridTemplateColumns: '150px minmax(0,1fr) auto', cursor: 'default' } },
              h('span', { className: 'cm-id' }, item.id),
              h('div', null,
                h('div', null, item.title),
                h('div', { className: 'cm-hint' }, `${item.duration_min} 分钟 · ${item.total_points} 分 · ${item.created_at?.slice(0, 10)}`),
              ),
              h(Btn, { kind: 'primary', size: 'sm', disabled: busy, onClick: () => start(item) }, '开始'),
            )),
          ),
        )
      }

      if (exam.status === 'graded' || exam.status === 'submitted') {
        return h('div', { className: 'cm-card' },
          h('h3', { className: 'cm-card-title' }, '这场已经交卷'),
          h('p', { className: 'cm-hint' }, `${exam.paper_title} · 交卷于 ${exam.submitted_at ?? ''}`),
          h(Btn, { onClick: () => exam.report_id && props.onReport(exam.report_id) }, '看成绩单'),
        )
      }

      const paused = exam.status === 'paused'
      const cells = []
      ;(paper?.sections ?? []).forEach((section, sectionIndex) => {
        const group = []
        ;(section.items ?? []).forEach((item, itemIndex) => {
          if (section.type === 'reading') {
            ;(item.questions ?? []).forEach((_question, questionIndex) => {
              group.push({ key: `${sectionIndex}:${itemIndex}:${questionIndex}`, si: sectionIndex, ii: itemIndex, qi: questionIndex, label: `${itemIndex + 1}-${questionIndex + 1}` })
            })
          } else {
            group.push({ key: `${sectionIndex}:${itemIndex}`, si: sectionIndex, ii: itemIndex, qi: null, label: `${itemIndex + 1}` })
          }
        })
        cells.push({ section, group })
      })

      const scrollTo = (key) => {
        currentRef.current = key
        const element = typeof document !== 'undefined' ? document.getElementById(`cm-q-${key}`) : null
        element?.scrollIntoView?.({ behavior: 'smooth', block: 'center' })
      }

      const answered = cells.flatMap((cell) => cell.group).filter((cell) => answers[cell.key]).length
      const totalCells = cells.flatMap((cell) => cell.group).length

      return h('div', null,
        h('div', { className: 'cm-exam-head' },
          h('div', null,
            h('div', { style: { fontWeight: 600 } }, exam.paper_title),
            h('div', { className: 'cm-hint' },
              `已答 ${answered} / ${totalCells} · 暂停 ${exam.pause_count} 次 · ${paused ? '已暂停' : '作答中'}`
              + (saveError ? ` · 保存失败：${saveError}` : savedAt ? ` · 已保存 ${formatTime(new Date(savedAt).toISOString()).slice(11)}` : ' · 每次作答即时保存'),
            ),
          ),
          h('div', { className: 'cm-row' },
            h('div', { className: `cm-timer${remaining < 300000 ? ' is-urgent' : ''}` }, formatDuration(remaining / 1000)),
            paused
              ? h(Btn, { kind: 'primary', onClick: resume, disabled: busy }, '继续')
              : h(Btn, { onClick: pause, disabled: busy }, '暂停'),
            h(Btn, { kind: 'danger', onClick: () => setConfirmSubmit(true), disabled: busy }, '交卷'),
          ),
        ),
        h('div', { className: 'cm-exam-body' },
          h('div', { className: 'cm-card cm-pause' },
            paused ? h('div', { className: 'cm-pause-banner' }, '已暂停 · 答题区只读，点右上角「继续」恢复') : null,
            (paper?.sections ?? []).map((section, sectionIndex) => h('section', { key: sectionIndex, style: { marginBottom: 26 } },
              h('div', { className: 'cm-section-head' },
                h('span', null, section.label),
                h(Chip, null, `${section.points} 分`),
                section.type === 'reading' ? h(Chip, null, `${section.items.length} 篇`) : null,
              ),
              section.items.map((item, itemIndex) => section.type === 'reading'
                ? h('div', { key: itemIndex, className: 'cm-q-block' },
                  h('p', { className: 'cm-passage' }, item.passage),
                  (item.questions ?? []).map((question, questionIndex) => {
                    const key = `${sectionIndex}:${itemIndex}:${questionIndex}`
                    return h('div', { key, id: `cm-q-${key}`, style: { marginBottom: 16 } },
                      h('p', { className: 'cm-stem' }, `${itemIndex + 1}.${questionIndex + 1}　${question.stem}`),
                      h('div', { className: 'cm-options' }, question.options.map((option, optionIndex) => {
                        const letter = String.fromCharCode(65 + optionIndex)
                        return h('button', {
                          key: letter,
                          type: 'button',
                          className: `cm-option${answers[key] === letter ? ' is-on' : ''}`,
                          disabled: paused,
                          onClick: () => save(key, letter),
                        }, h('span', { className: 'cm-option-key' }, letter), h('span', null, option))
                      })),
                    )
                  }),
                )
                : section.type === 'ja2zh' || section.type === 'zh2ja'
                  ? h('div', { key: itemIndex, className: 'cm-q-block', id: `cm-q-${sectionIndex}:${itemIndex}` },
                    h('div', { className: 'cm-row', style: { justifyContent: 'space-between' } },
                      h('strong', null, `${itemIndex + 1}. ${item.title || '原文'}`),
                      h('span', { className: 'cm-hint' }, `原文 ${item.chars} 字 · 你译了 ${countChars(answers[`${sectionIndex}:${itemIndex}`])} 字`),
                    ),
                    h('p', { className: 'cm-passage' }, item.text),
                    h('textarea', {
                      className: 'cm-area',
                      value: answers[`${sectionIndex}:${itemIndex}`] ?? '',
                      readOnly: paused,
                      placeholder: '在这里作答',
                      style: { minHeight: 220 },
                      onChange: (event) => save(`${sectionIndex}:${itemIndex}`, event.target.value),
                    }),
                  )
                  : h('div', { key: itemIndex, className: 'cm-q-block', id: `cm-q-${sectionIndex}:${itemIndex}` },
                    h('p', { className: 'cm-stem' }, `${itemIndex + 1}. ${item.stem}`),
                    h('div', { className: 'cm-options' }, (item.options ?? []).map((option, optionIndex) => {
                      const letter = String.fromCharCode(65 + optionIndex)
                      const key = `${sectionIndex}:${itemIndex}`
                      return h('button', {
                        key: letter,
                        type: 'button',
                        className: `cm-option${answers[key] === letter ? ' is-on' : ''}`,
                        disabled: paused,
                        onClick: () => save(key, letter),
                      }, h('span', { className: 'cm-option-key' }, letter), h('span', null, option))
                    })),
                  ),
              ),
            )),
          ),
          h('div', { className: 'cm-card-wrap' },
            h('div', { className: 'cm-card', style: { padding: 12 } },
              h('p', { className: 'cm-card-title', style: { fontSize: 12, marginBottom: 8 } }, '答题卡'),
              cells.map((cell, index) => h('div', { key: index, className: 'cm-cell-group' },
                h('p', { className: 'cm-cell-title' }, `${cell.section.label} ${cell.section.points} 分`),
                h('div', { className: 'cm-cells' }, cell.group.map((entry) => h('button', {
                  key: entry.key,
                  type: 'button',
                  className: `cm-cell${answers[entry.key] ? ' is-done' : ''}`,
                  onClick: () => scrollTo(entry.key),
                  title: entry.label,
                }, entry.label.replace(/^\d+-/u, '')))),
              )),
            ),
          ),
        ),
        confirmSubmit ? h(Modal, {
          title: '确认交卷？',
          onClose: () => setConfirmSubmit(false),
          footer: [
            h(Btn, { key: 'cancel', onClick: () => setConfirmSubmit(false) }, '再想想'),
            h(Btn, { key: 'ok', kind: 'danger', onClick: submit, disabled: busy }, '交卷'),
          ],
        },
        h('p', { className: 'cm-hint' }, `未作答 ${totalCells - answered} 题。交卷后不能再改；实务段本次只保存原文，AI 双评在 v1 提供。`),
        ) : null,
      )
    }

    // ------------------------------------------------------------------ 成绩

    function ReportView(props) {
      const [reports, setReports] = useState([])
      const [report, setReport] = useState(null)
      const [busy, setBusy] = useState(false)

      const load = useCallback(async () => {
        try {
          const list = await call('report.list')
          setReports(list.reports)
          if (props.reportId) {
            const result = await call('report.get', { reportId: props.reportId })
            setReport(result.report)
          } else if (!report && list.reports[0]) {
            const result = await call('report.get', { reportId: list.reports[0].id })
            setReport(result.report)
          }
        } catch (error) {
          props.toast(error.message, 'error')
        }
      }, [props.reportId])

      useEffect(() => { void load() }, [load])

      const open = async (id) => {
        try {
          const result = await call('report.get', { reportId: id })
          setReport(result.report)
        } catch (error) {
          props.toast(error.message, 'error')
        }
      }

      const exportMd = async () => {
        if (!report) return
        setBusy(true)
        try {
          const result = await call('report.export', { reportId: report.id })
          props.toast(`已导出：${result.file}`)
        } catch (error) {
          props.toast(error.message, 'error')
        } finally {
          setBusy(false)
        }
      }

      const [grading, setGrading] = useState(null)

      const pollGrade = (id) => {
        const timer = setInterval(async () => {
          try {
            const result = await call('grade.status', { reportId: id })
            const job = result.job
            if (!job) return
            setGrading(job)
            if (job.state === 'running') return
            clearInterval(timer)
            setBusy(false)
            if (job.state === 'done') {
              props.toast(`批改完成：${job.total} / ${job.max}`)
              const fresh = await call('report.get', { reportId: id })
              setReport(fresh.report)
              await load()
            } else {
              props.toast(job.error || '批改失败', 'error')
            }
          } catch (error) {
            /* 轮询失败不打断 */
          }
        }, 2000)
      }

      const startGrade = async () => {
        if (!report) return
        setBusy(true)
        try {
          const result = await call('grade.start', { reportId: report.id })
          setGrading(result.job)
          props.toast('开始批改，可能要一两分钟')
          pollGrade(report.id)
        } catch (error) {
          props.toast(error.message, 'error')
          setBusy(false)
        }
      }

      const removeReport = async () => {
        if (!report) return
        if (!window.confirm(`删除成绩单 ${report.id}？文件会被删掉，试卷保留。`)) return
        setBusy(true)
        try {
          await call('report.delete', { reportId: report.id })
          props.toast('已删除成绩单')
          setReport(null)
          await load()
        } catch (error) {
          props.toast(error.message, 'error')
        } finally {
          setBusy(false)
        }
      }

      return h('div', { className: 'cm-grid cm-grid-side' },
        h('div', { className: 'cm-card', style: { padding: 8 } },
          h('p', { className: 'cm-card-title', style: { padding: '4px 6px', marginBottom: 4 } }, `成绩单（${reports.length}）`),
          reports.length === 0 ? h(Empty, null, '还没有成绩单。') : h('div', { className: 'cm-bank-nav cm-scroll' },
            reports.map((entry) => h('button', {
              key: entry.id,
              type: 'button',
              className: `cm-bank-item${report?.id === entry.id ? ' is-on' : ''}`,
              onClick: () => open(entry.id),
            },
            h('span', null,
              h('div', null, entry.paper_title),
              h('div', { className: 'cm-hint' },
                `${formatTime(entry.submitted_at)} · `
                + (entry.status === 'pending_review'
                  ? '待判分'
                  : entry.max > 0
                    ? `${entry.total}/${entry.max}${entry.pass === null ? '' : entry.pass ? ' 达线' : ' 未达线'}`
                    : '未评分')),
            ),
            )),
          ),
        ),
        !report ? h('div', { className: 'cm-card' }, h(Empty, null, '左边选一份成绩单。')) : h('div', null,
          h('div', { className: 'cm-card' },
            h('div', { className: 'cm-row', style: { justifyContent: 'space-between' } },
              h('h3', { className: 'cm-card-title', style: { margin: 0 } }, report.paper_title),
              h('div', { className: 'cm-row' },
                report.status === 'pending_review'
                  ? h(Btn, { kind: 'primary', size: 'sm', onClick: startGrade, disabled: busy }, grading?.state === 'running' ? '批改中…' : '一键批改')
                  : null,
                h(Btn, { size: 'sm', onClick: exportMd, disabled: busy }, '导出 Markdown'),
                h(Btn, { size: 'sm', disabled: busy, onClick: removeReport }, '删除'),
              ),
            ),
            h('p', { className: 'cm-hint' }, `交卷 ${formatTime(report.submitted_at)} · ${report.submit_reason === 'timeout' ? '到点自动交卷' : '手动交卷'} · 用时 ${formatLong(report.used_seconds)} · 暂停 ${report.pause_count} 次共 ${formatLong(report.pause_seconds)}`),
            h('div', { className: 'cm-spacer' }),
            h('div', { className: 'cm-score', style: { gridTemplateColumns: report.practice?.max > 0 ? undefined : 'repeat(2,minmax(0,1fr))' } },
              h('div', { className: 'cm-score-card' },
                h('div', { className: 'cm-score-label' }, report.status === 'pending_review' ? '总分（仅客观题）' : '总分'),
                h('div', { className: 'cm-score-num' }, report.max > 0 ? `${report.total} / ${report.max}` : '未评分'),
              ),
              h('div', { className: 'cm-score-card' },
                h('div', { className: 'cm-score-label' }, '综合'),
                h('div', { className: 'cm-score-num' }, report.comprehensive?.max > 0 ? `${report.comprehensive.earned} / ${report.comprehensive.max}` : '—'),
              ),
              report.practice?.max > 0
                ? h('div', { className: 'cm-score-card' },
                  h('div', { className: 'cm-score-label' }, '实务'),
                  h('div', { className: 'cm-score-num' }, report.practice.graded ? `${report.practice.earned} / ${report.practice.max}` : '待判分'),
                )
                : null,
            ),
            report.status === 'pending_review'
              ? h('div', { className: 'cm-warn', style: { fontSize: 13, lineHeight: '21px' } },
                h('div', { style: { fontWeight: 600, marginBottom: 4 } }, '实务段待判分（pending_review）'),
                h('div', null, `客观题已判：综合 ${report.comprehensive.earned} / ${report.comprehensive.max}。实务要在这个会话里让 Agent 判：`),
                h('div', { style: { marginTop: 4 } },
                  h('code', null, `catti_grade material reportId=${report.id}`),
                  ' → 起两个子智能体各写一份评分 JSON → ',
                  h('code', null, 'catti_grade commit'),
                  ' 写回。两份都齐了才会出总分与合否。',
                ),
              )
              : null,
            grading && grading.state === 'running'
              ? h('div', { className: 'cm-warn' }, `批改中：${grading.progress ?? '准备中'}（已收 ${grading.reviews ?? 0} 份评分）`)
              : null,
            grading && grading.state === 'error'
              ? h('div', { className: 'cm-warn' }, `批改失败：${grading.error}`)
              : null,
            report.pass !== null ? h('div', { className: 'cm-row', style: { marginBottom: 8 } },
              h(Chip, { tone: report.pass ? 'ok' : 'error' }, report.pass ? '达线（60%）' : '未达线（60%）'),
            ) : null,
            (report.notes ?? []).map((note, index) => h('div', { key: index, className: 'cm-warn' }, note)),
          ),
          h('div', { className: 'cm-card' },
            h('h3', { className: 'cm-card-title' }, '分项'),
            h('table', { className: 'cm-table' },
              h('thead', null, h('tr', null, ['题型', '得分', '满分', '待议', '已答'].map((label) => h('th', { key: label }, label)))),
              h('tbody', null, report.sections.map((section) => h('tr', { key: section.type },
                h('td', null, section.label),
                h('td', { className: 'num' }, section.graded ? section.earned : '待判分'),
                h('td', { className: 'num' }, section.max),
                h('td', { className: 'num' }, section.disputed_points ?? 0),
                h('td', { className: 'num' }, `${section.answered_questions ?? section.answered ?? 0}/${section.total_questions ?? section.total_items ?? section.items?.length ?? 0}`),
              ))),
            ),
          ),
          report.sections.map((section) => h('div', { key: section.type, className: 'cm-card' },
            h('h3', { className: 'cm-card-title' }, `${section.label} · ${section.graded ? `${section.earned} / ${section.max}` : '待判分'}`),
            section.review
              ? h('div', { className: 'cm-hint', style: { marginBottom: 8 } },
                `${section.review.method === 'mean3' ? '三评' : '双评'}取均值（A/B 差 ${section.review.diff} 分，阈值 ${section.review.threshold}）：`
                + section.review.reviewers.map((entry) => `${entry.reviewer} ${entry.score}`).join(' · '))
              : null,
            section.type === 'ja2zh' || section.type === 'zh2ja'
              ? h('div', null,
                section.graded ? null : h('p', { className: 'cm-hint' }, section.note ?? '待判分。'),
                // 批改意见：把两位评审的分项、采分点、错误清单摊开
                section.review
                  ? h('div', { className: 'cm-review' },
                    h('div', { className: 'cm-review-head' },
                      `批改意见（${section.review.method === 'mean3' ? '三评取均值' : '双评取均值'} ${section.review.raw_score} 分）`),
                    (section.review.reviewers ?? []).map((entry) => h('details', { key: entry.reviewer, className: 'cm-details' },
                      h('summary', null, `评审 ${entry.reviewer} · ${entry.score} 分`
                        + (entry.breakdown ? ` · 忠实 ${entry.breakdown['忠实'] ?? '-'} / 通顺 ${entry.breakdown['通顺'] ?? '-'} / 术语 ${entry.breakdown['术语'] ?? '-'} / 格式 ${entry.breakdown['格式'] ?? '-'}` : '')),
                      (entry.points ?? []).length > 0
                        ? h('div', { style: { marginTop: 6 } },
                          h('div', { className: 'cm-hint' }, '采分点'),
                          h('ul', { className: 'cm-list-plain' }, (entry.points ?? []).map((point, index) => h('li', { key: index, className: 'cm-hint' },
                            `${point['点'] ?? point.point ?? ''}：${point['判定'] ?? point.verdict ?? ''}${point['位置'] ? `（${point['位置']}）` : ''}`))))
                        : null,
                      (entry.errors ?? []).length > 0
                        ? h('div', { style: { marginTop: 6 } },
                          h('div', { className: 'cm-hint' }, '问题清单'),
                          h('ul', { className: 'cm-list-plain' }, (entry.errors ?? []).map((error, index) => h('li', { key: index, className: 'cm-hint' },
                            `${error['类型'] ?? error.type ?? ''}：${error['理由'] ?? error.reason ?? ''}`
                            + (error['原文'] ? `｜原文：${error['原文']}` : '')
                            + (error['译文'] ? `｜译文：${error['译文']}` : '')))))
                        : null,
                      entry.note ? h('p', { className: 'cm-hint' }, entry.note) : null,
                    )),
                  )
                  : null,
                (section.items ?? []).map((item) => h('div', { key: item.item_id, className: 'cm-pair', style: { display: 'grid', gridTemplateColumns: window.innerWidth > 900 ? 'repeat(3,minmax(0,1fr))' : 'minmax(0,1fr)', gap: 10, marginTop: 10 } },
                  h('div', { className: 'cm-pair-col' },
                    h('div', { className: 'cm-pair-label' }, `原文 · ${item.chars} 字`),
                    h('div', { className: 'cm-pair-text' }, item.text || item.title)),
                  h('div', { className: 'cm-pair-col' },
                    h('div', { className: 'cm-pair-label' }, `你的译文 · ${countChars(item.answer || '')} 字${item.answered ? '' : '（未作答）'}`),
                    h('div', { className: 'cm-pair-text' }, item.answer || '（空）')),
                  h('div', { className: 'cm-pair-col', style: { border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8, padding: 10, background: 'var(--dsw-alias-bg-layer-2)' } },
                    h('div', { className: 'cm-pair-label', style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', marginBottom: 6 } }, item.ref_src === 'official' ? '参考译文（来源给定）' : item.ref_src === 'ai_solved' ? '参考译文（AI 补的，仅提示）' : '参考译文'),
                    h('div', { className: 'cm-pair-text' }, item.ref || '（没有参考译文）')),
                )),
              )
              : h('div', null, (section.items ?? []).map((item) => h('details', { key: item.item_id, className: 'cm-details' },
                h('summary', null, `${item.item_id} · ${item.disputed ? '争议' : item.correct ? '对' : '错'} · ${item.earned} / ${item.points}`),
                h('div', { style: { marginTop: 8 } },
                  (item.questions ?? []).map((question, index) => h('div', { key: index, style: { marginBottom: 10 } },
                    h('p', { className: 'cm-stem', style: { fontSize: 13, marginBottom: 6 } }, question.stem),
                    h('div', { className: `cm-verdict ${question.disputed ? '' : question.correct ? 'ok' : 'bad'}` },
                      h('span', null, `你的答案 ${question.user_answer || '（空）'} · 答案 ${question.answer || '—'} · ${question.disputed ? '暂不判分' : question.correct ? '正确' : '错误'}`),
                    ),
                    question.reason ? h('p', { className: 'cm-hint' }, question.reason) : null,
                    question.explanation ? h('p', { className: 'cm-hint' }, `解析：${question.explanation}`) : null,
                  )),
                ),
              ))),
          )),
          (report.disputed ?? []).length > 0 ? h('div', { className: 'cm-card' },
            h('h3', { className: 'cm-card-title' }, `待议清单（${report.disputed.length}）`),
            h('p', { className: 'cm-hint' }, '本题 AI 答案与你的答案不一致，暂不判分。'),
            h('table', { className: 'cm-table' },
              h('thead', null, h('tr', null, ['题号', '题干', '你的答案', 'AI 答案', '说明'].map((label) => h('th', { key: label }, label)))),
              h('tbody', null, report.disputed.map((item, index) => h('tr', { key: index },
                h('td', null, `${item.item_id}${item.question_index === null ? '' : `-${item.question_index + 1}`}`),
                h('td', null, item.stem),
                h('td', null, item.user_answer || '（空）'),
                h('td', null, item.ai_answer),
                h('td', null, item.reason),
              ))),
            ),
          ) : null,
        ),
      )
    }

    // ------------------------------------------------------------------ 外壳

    function CattiPage() {
      useStyles()
      const [tab, setTab] = useState('bank')
      const [state, setState] = useState(null)
      const [toast, setToast] = useState(null)
      const [reportId, setReportId] = useState(null)
      const [examId, setExamId] = useState(null)
      const toastTimer = useRef(null)

      const showToast = useCallback((message, tone) => {
        setToast({ message, tone })
        clearTimeout(toastTimer.current)
        toastTimer.current = setTimeout(() => setToast(null), tone === 'error' ? 6000 : 3500)
      }, [])

      const refresh = useCallback(async () => {
        try {
          const data = await call('state')
          setState(data)
          if (data.exam && !examId) setExamId(data.exam.id)
        } catch (error) {
          showToast(error.message, 'error')
        }
      }, [showToast, examId])

      useEffect(() => {
        void refresh()
        const timer = setInterval(() => { void refresh() }, 60000)
        return () => {
          clearInterval(timer)
          clearTimeout(toastTimer.current)
        }
      }, [])

      const tabs = [
        ['bank', '题库'],
        ['paper', '组卷'],
        ['exam', '考试'],
        ['report', '成绩'],
      ]

      return h('div', {
        'data-cm': '',
        className: 'cm-root',
        // 版面与滚动写在内联样式里：这页是整块主面板，根节点必须是「自己滚」的那一层，
        // 否则外层滚、里层滚会打架，滚动条也不在页面上。
        style: {
          maxWidth: 1180,
          margin: '0 auto',
          padding: 'var(--dsh-frame-top-clearance,0px) 28px 64px',
          paddingTop: 'calc(var(--dsh-frame-top-clearance,0px) + 20px)',
          maxHeight: '100vh',
          overflowY: 'auto',
          overscrollBehavior: 'contain',
          boxSizing: 'border-box',
        },
      },
        h('div', { className: 'cm-head' },
          h('div', null,
            h('h1', { className: 'cm-title' }, 'CATTI 日语笔译二级 · 模考'),
            h('p', { className: 'cm-sub' }, state ? `数据目录：${state.dataDir}` : '读取中…'),
          ),
          h('div', { className: 'cm-actions' },
            state?.exam
              ? h(Btn, { size: 'sm', kind: 'primary', onClick: () => setTab('exam') }, '考试进行中 · 回到考试')
              : null,
            h(Btn, { size: 'sm', onClick: refresh }, '刷新'),
          ),
        ),
        h('nav', { className: 'cm-tabs' }, tabs.map(([key, label]) => h('button', {
          key,
          type: 'button',
          className: `cm-tab${tab === key ? ' is-on' : ''}`,
          onClick: () => setTab(key),
        }, label))),
        tab === 'bank' ? h(BankView, { state, toast: showToast, refresh }) : null,
        tab === 'paper' ? h(PaperView, {
          toast: showToast,
          onExamStarted: () => {
            setTab('exam')
            setExamId(null)
            void refresh()
          },
        }) : null,
        tab === 'exam' ? h(ExamView, {
          examId,
          toast: showToast,
          onReport: (id) => {
            setReportId(id)
            setTab('report')
            setExamId(null)
            void refresh()
          },
          onRefreshState: refresh,
        }) : null,
        tab === 'report' ? h(ReportView, { reportId, toast: showToast }) : null,
        toast ? h(Toast, { message: toast.message, tone: toast.tone }) : null,
      )
    }

    class ErrorBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }

      static getDerivedStateFromError(error) {
        return { error }
      }

      render() {
        if (this.state.error) {
          return h('div', { 'data-cm': '', style: { padding: 24, fontSize: 13 } },
            h('p', null, 'CATTI 模考页面出错了：'),
            h('pre', { style: { whiteSpace: 'pre-wrap', color: 'var(--dsw-alias-state-error-primary)' } }, String(this.state.error?.stack ?? this.state.error)),
          )
        }
        return this.props.children
      }
    }

    function CattiPageGuarded() {
      return h(ErrorBoundary, null, h(CattiPage))
    }

    const HEX_PATH = 'M18 7.5a3.2 3.2 0 1 1-1.6-2.77M18 7.5v3.2h-3.2'
    function PanelIcon(props) {
      const size = Number(props?.size) || 18
      const active = Boolean(props?.active)
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 36 36',
        fill: 'none',
        'aria-hidden': true,
        style: { display: 'block' },
      },
        h('rect', {
          x: 5.5, y: 4.5, width: 20, height: 26, rx: 3,
          stroke: 'currentColor', strokeOpacity: active ? 1 : 0.85, strokeWidth: 2,
          fill: active ? 'currentColor' : 'none', fillOpacity: active ? 0.1 : 0,
        }),
        h('path', { d: 'M10.5 11h10M10.5 16h10M10.5 21h6', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', opacity: 0.7 }),
        h('path', { d: HEX_PATH, stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' }),
      )
    }

    // ------------------------------------------------------------------ 注册

    function apply(ctx) {
      try {
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: 'catti',
          label: () => 'CATTI 模考',
        }, CattiPageGuarded))
      } catch (error) {
        console.error('[dsh-nihongo-test] main panel registration failed', error)
      }
      try {
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: 'catti',
          order: 20,
          label: () => 'CATTI 模考',
        }, PanelIcon))
      } catch (error) {
        console.error('[dsh-nihongo-test] sidebar entry registration failed', error)
      }
    }

    exports.apply = apply
    exports.inject = ['slots']
    return module.exports
  },
})

















