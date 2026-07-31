import { readFile } from 'node:fs/promises'
import { config } from '../config.js'
import { query } from '../db/index.js'
import {
  createPublicShareMetadata,
  createStandaloneUnavailablePage,
  createUnavailableShareMetadata,
  injectPublicShareMetadata
} from '../lib/publicSharePage.js'

const SHARE_CODE_PATTERN = /^[A-Za-z0-9]{8}$/

function setPublicHtmlHeaders(reply) {
  reply.header('Cache-Control', 'private, no-store')
  reply.header('X-Robots-Tag', 'noindex, noarchive, nofollow')
  reply.header('Referrer-Policy', 'no-referrer')
  reply.header('Content-Language', 'zh-CN')
  reply.type('text/html; charset=utf-8')
}

function sendStandaloneUnavailable(reply) {
  setPublicHtmlHeaders(reply)
  return reply
    .code(503)
    .send(createStandaloneUnavailablePage())
}

function renderShell(indexHtml, metadata) {
  return injectPublicShareMetadata(indexHtml, metadata)
}

export default async function publicSharePageRoutes(fastify) {
  fastify.get('/share/:code', {
    config: {
      skipSession: true
    }
  }, async (request, reply) => {
    setPublicHtmlHeaders(reply)

    let indexHtml
    try {
      // Read on every request so independently deployed Vite asset hashes stay current.
      indexHtml = await readFile(config.frontendIndexPath, 'utf8')
    } catch (error) {
      request.log.error({ err: error }, 'Unable to read the current frontend index')
      return sendStandaloneUnavailable(reply)
    }

    const code = String(request.params?.code || '').trim()
    if (!SHARE_CODE_PATTERN.test(code)) {
      return reply
        .code(404)
        .send(renderShell(
          indexHtml,
          createUnavailableShareMetadata(code, {
            appOrigin: config.publicAppOrigin
          })
        ))
    }

    let record
    try {
      const { rows } = await query(
        `
          SELECT
            s.code,
            n.title,
            n.content,
            n.attachments
          FROM note_shares s
          JOIN notes n ON n.id = s.note_id
          WHERE s.code = $1
            AND (s.expire_at IS NULL OR s.expire_at > NOW())
            AND n.encrypted = FALSE
          LIMIT 1
        `,
        [code]
      )
      record = rows[0] || null
    } catch (error) {
      request.log.error({ err: error }, 'Unable to load public share metadata')
      return reply
        .code(503)
        .send(renderShell(
          indexHtml,
          createUnavailableShareMetadata(code, {
            appOrigin: config.publicAppOrigin,
            serviceUnavailable: true
          })
        ))
    }

    if (!record) {
      return reply
        .code(404)
        .send(renderShell(
          indexHtml,
          createUnavailableShareMetadata(code, {
            appOrigin: config.publicAppOrigin
          })
        ))
    }

    return reply
      .code(200)
      .send(renderShell(
        indexHtml,
        createPublicShareMetadata(record, {
          appOrigin: config.publicAppOrigin,
          imgBedBaseUrl: config.imgBedBaseUrl
        })
      ))
  })
}
