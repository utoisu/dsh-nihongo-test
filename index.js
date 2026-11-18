/**
 * CATTI 日语笔译二级 模考 —— Host 半边。
 *
 * apply() 只做注册，不碰磁盘、不扫目录、不等服务：启动路径越轻越好。
 * 真正的初始化在 CattiStore 的 ready() 里，第一次用到时才跑，失败也只影响本插件。
 */
import { randomBytes } from 'node:crypto'
import path from 'node:path'

import { CattiStore } from './lib/store.js'
import { CattiService } from './lib/service.js'
import { createApi } from './lib/api.js'
import { createTools } from './lib/tools.js'

export const name = 'dsh-nihongo-test'

// tools 是硬依赖（没有它插件没有意义）；webServer 走动态 inject，
// 没有 Web 界面的宿主照样能注册工具，只是看不到页面。
export const inject = ['tools']

const BASE_PATH = '/dsh-nihongo-test'
const INDEX_GLOBAL = '__DSH_NIHONGO_TEST__'

function resolveDataDir(ctx, config) {
  if (typeof config?.dataDir === 'string' && config.dataDir.trim()) {
    return path.resolve(config.dataDir.trim())
  }
  let workspace = ''
  try {
    const workingDirectory = typeof ctx.get === 'function' ? ctx.get('workingDirectory') : null
    if (workingDirectory && typeof workingDirectory.defaultDirectory === 'string') {
      workspace = workingDirectory.defaultDirectory
    }
  } catch {
    /* 老宿主没有这个服务，落到 cwd */
  }
  if (!workspace) workspace = process.env.DSH_WORKSPACE || process.cwd()
  return path.join(workspace, '.dsh-nihongo-test')
}

export function apply(ctx, config = {}) {
  const disposers = []
  const logger = (message) => {
    try {
      ctx.logger?.warn?.(message)
    } catch {
      /* 连日志都写不了就算了 */
    }
  }

  try {
    const dataDir = resolveDataDir(ctx, config)
    const corpusPath = typeof config?.corpusPath === 'string' ? config.corpusPath.trim() : ''
    const token = randomBytes(16).toString('hex')

    const store = new CattiStore({ dataDir, corpusPath, logger })
    const service = new CattiService({ store, logger, ctx })

    // 1) Agent 工具：五个，和页面共用 service。
    for (const tool of createTools(service)) {
      disposers.push(ctx.tools.register(tool))
    }

    // 2) 把接口地址与 token 注入页面。桌面端这张注入表在宿主启动时收集一次，
    //    所以这一行必须在 apply 里同步注册，不能等服务就绪。
    try {
      const offIndex = ctx.on('webserver/index-inject', (table) => {
        table.push({
          kind: 'global',
          name: INDEX_GLOBAL,
          value: { url: BASE_PATH, token },
        })
      })
      disposers.push(offIndex)
    } catch (error) {
      logger(`[dsh-nihongo-test] index injection unavailable: ${error?.message ?? error}`)
    }

    // 3) 本机接口：页面用 fetch 调它，和工具走同一套逻辑。
    if (typeof ctx.inject === 'function') {
      const off = ctx.inject(['webServer'], (webCtx) => {
        try {
          const handler = createApi({
            service,
            token,
            basePath: `${BASE_PATH}/api`,
            logger,
          })
          const disposeRoute = webCtx.webServer.register({
            kind: 'prefix',
            path: BASE_PATH,
            handler,
          })
          logger(`[dsh-nihongo-test] 页面接口已就绪：${BASE_PATH}/api（数据目录 ${dataDir}）`)
          return () => {
            try {
              disposeRoute()
            } catch {
              /* 已经关掉了 */
            }
          }
        } catch (error) {
          logger(`[dsh-nihongo-test] route registration failed: ${error?.message ?? error}`)
          return undefined
        }
      })
      if (typeof off === 'function') disposers.push(off)
    }

    // 4) 到点自动交卷：Host 时钟，5 秒一拍。页面自己倒计时只负责显示。
    try {
      const tick = () => {
        service.tick().then((result) => {
          for (const entry of result.auto_submitted) {
            logger(`[dsh-nihongo-test] 到点自动交卷：${entry.exam_id} → 成绩单 ${entry.report_id}`)
          }
        }).catch((error) => {
          logger(`[dsh-nihongo-test] tick failed: ${error?.message ?? error}`)
        })
      }
      const offTick = typeof ctx.interval === 'function'
        ? ctx.interval(tick, 5000)
        : (() => {
          const handle = setInterval(tick, 5000)
          handle.unref?.()
          return () => clearInterval(handle)
        })()
      disposers.push(offTick)
    } catch (error) {
      logger(`[dsh-nihongo-test] timer unavailable: ${error?.message ?? error}`)
    }

    // 启动时清一下已经到点的旧场次。
    void service.tick().catch(() => {})
  } catch (error) {
    logger(`[dsh-nihongo-test] failed to load: ${error?.stack ?? error}`)
  }

  return () => {
    for (const dispose of disposers.reverse()) {
      try {
        dispose?.()
      } catch {
        /* 卸载阶段不抛 */
      }
    }
  }
}


