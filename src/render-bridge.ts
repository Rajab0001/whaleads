import type { Env } from './db'
import { logEvent } from './db'
import { resolveActive } from './adaptors'
import type { CloudApiConfig } from './adaptors/types'
import { outboundConversation, outboundMessageInsert } from './conversations'
import { publishMessage } from './live'

function equal(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

async function signature(secret: string, raw: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const bytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(raw)))
  return 'sha256=' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** Accepts only bot replies mirrored by Render and signed with the same Meta app secret. */
export async function handleRenderBridge(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const raw = await req.text()
  if (!raw || raw.length > 8192) return new Response('invalid body', { status: 400 })
  const active = await resolveActive(env)
  if (!active || active.kind !== 'cloud_api') return new Response('Cloud API is not configured', { status: 503 })
  const secret = (active.config as CloudApiConfig).app_secret
  if (!secret) return new Response('bridge is not configured', { status: 503 })
  const expected = await signature(secret, raw)
  if (!equal(expected, req.headers.get('x-ada-bridge-signature') ?? '')) return new Response('invalid signature', { status: 401 })

  let data: any
  try { data = JSON.parse(raw) } catch { return new Response('invalid JSON', { status: 400 }) }
  if (data?.type !== 'bot_outbound'
      || typeof data.customer !== 'string' || !/^[0-9]{5,20}$/.test(data.customer)
      || typeof data.body !== 'string' || data.body.length > 4096
      || typeof data.wamid !== 'string' || !/^wamid\.[A-Za-z0-9_-]{8,256}$/.test(data.wamid)
      || !Number.isInteger(data.timestamp) || data.timestamp < 0) {
    return new Response('invalid event', { status: 400 })
  }

  let contact = await env.DB.prepare('SELECT id FROM contacts WHERE wa_id=?1 OR (wa_id IS NULL AND phone=?1) LIMIT 1')
    .bind(data.customer).first<{ id: number }>()
  if (!contact) {
    await env.DB.prepare("INSERT INTO contacts (wa_id, phone, source) VALUES (?1,?1,'whatsapp') ON CONFLICT(wa_id) DO NOTHING")
      .bind(data.customer).run()
    contact = await env.DB.prepare('SELECT id FROM contacts WHERE wa_id=?1 LIMIT 1').bind(data.customer).first<{ id: number }>()
  }
  if (!contact) return new Response('contact could not be saved', { status: 500 })
  await env.DB.prepare('UPDATE contacts SET wa_id=?2, last_seen_at=unixepoch() WHERE id=?1').bind(contact.id, data.customer).run()
  await env.DB.batch([
    outboundMessageInsert(env.DB, contact.id, data.wamid, 'text', data.body, null, data.timestamp, 'bot'),
    outboundConversation(env.DB, contact.id, data.timestamp, data.body.slice(0, 140)),
  ])
  ctx.waitUntil(logEvent(env.DB, 'render_bridge_outbound', { wamid: data.wamid }))
  publishMessage(env, ctx, contact.id, { wamid: data.wamid })
  return new Response('ok', { status: 200 })
}

/** Pause Render's automatic replies before WhaLeads sends a staff response. */
export async function setBotHumanMode(env: Env, customer: string): Promise<boolean> {
  if (!/^[0-9]{5,20}$/.test(customer)) return false
  const active = await resolveActive(env)
  if (!active || active.kind !== 'cloud_api') return false
  const secret = (active.config as CloudApiConfig).app_secret
  if (!secret) return false
  const raw = JSON.stringify({ customer, human_mode: true })
  const url = (env.RENDER_BOT_URL || 'https://adabot-rkes.onrender.com').replace(/\/+$/, '')
  try {
    const res = await fetch(url + '/bridge/handoff', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ada-bridge-signature': await signature(secret, raw) },
      body: raw,
      signal: AbortSignal.timeout(8000),
    })
    return res.ok
  } catch (e) {
    console.error(JSON.stringify({ at: 'render_handoff', error: String(e) }))
    return false
  }
}
