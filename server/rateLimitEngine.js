/**
 * Centralised rate-limit engine — Express.
 *
 * Copy this file into the project alongside your app entry point as
 * `rateLimitEngine.js`, then create the middleware with the project slug and
 * its buckets:
 *
 *   import { createRateLimiter } from './rateLimitEngine.js'
 *
 *   const limiter = createRateLimiter({
 *     project: 'my-project',
 *     buckets: { chat: Number(process.env.RATE_LIMIT_CHAT_MAX || 5) },
 *     redisUrl: process.env.UPSTASH_REDIS_REST_URL || process.env.UPSTASH_REDIS_URL,
 *     redisToken: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.UPSTASH_REDIS_TOKEN,
 *     defaultWindow: Number(process.env.RATE_LIMIT_WINDOW_SECONDS || 432000),
 *   })
 *
 *   app.post('/api/chat', limiter('chat'), chatHandler)
 *
 * Requires `@upstash/redis`. Limits and switches are read from the shared Upstash
 * Redis DB at request time, cached, with the `buckets` values as the fallback.
 * See the central rate-limit config documentation for the key schema.
 */
import net from 'node:net'
import { Redis } from '@upstash/redis'

export const ENGINE_VERSION = '1.4.0'

// How many proxies in front of the app append to X-Forwarded-For. The client IP is
// the entry the outermost trusted proxy appended, counted from the right; anything
// further left was sent by the client and can be forged. Cloud Run's front end
// appends exactly one entry. 0 = trust the leftmost entry (only behind a proxy that
// overwrites the header).
const XFF_HOPS = Number.parseInt(process.env.RATE_LIMIT_XFF_HOPS || '1', 10)

const BLOCKED_CACHE_MAX = 10000 // identities remembered as over the limit, per instance

// IPv4 as is; IPv6 grouped by its /64, because one phone or household rotates through
// addresses inside it; IPv4-mapped IPv6 back to IPv4. Non-IPs unchanged.
export function normaliseIp(ip) {
  let raw = String(ip).trim()
  const v4Port = raw.match(/^(\d+\.\d+\.\d+\.\d+):\d+$/)
  if (v4Port) raw = v4Port[1]
  raw = raw.replace(/^\[|\]$/g, '').split('%')[0]
  if (net.isIPv4(raw)) return raw
  if (!net.isIPv6(raw)) return raw || 'unknown'
  const mapped = raw.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)
  if (mapped) return mapped[1]
  const parts = raw.split('::')
  const toGroups = (str) => (str ? str.split(':') : []).flatMap((g) => (g.includes('.') ? ['0', '0'] : [g]))
  const head = toGroups(parts[0])
  const tail = parts.length > 1 ? toGroups(parts[1]) : []
  const groups = parts.length > 1 ? [...head, ...Array(8 - head.length - tail.length).fill('0'), ...tail] : head
  return groups.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(':') + '::/64'
}

export function ipFromXff(xff, hops = XFF_HOPS) {
  const entries = String(xff).split(',').map((e) => e.trim()).filter(Boolean)
  if (!entries.length) return null
  if (!(hops > 0)) return entries[0]
  return entries[Math.max(entries.length - hops, 0)]
}

// Real client IP from X-Forwarded-For (Cloud Run / proxies sit in front, so req.ip
// can be the proxy), normalised.
export function clientIp(req) {
  const xff = req.headers['x-forwarded-for']
  const ip = (xff && ipFromXff(xff)) || req.ip || (req.socket && req.socket.remoteAddress) || 'unknown'
  return normaliseIp(ip)
}

// 32-bit FNV-1a: spreads each identity's window start so windows don't all roll over at once.
function hash32(str) {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

export function createRateLimiter({
  project,
  buckets,
  redisUrl,
  redisToken,
  defaultWindow = 432000,
  cacheTtl = 90,
}) {
  const redis = redisUrl && redisToken ? new Redis({ url: redisUrl, token: redisToken }) : null
  const cache = { t: 0, salt: '', killed: false, limits: { ...buckets }, window: defaultWindow }
  // counter key (without window number) -> time (s) until which it is known to be over
  let blocked = new Map()

  // Update the cached config; forget remembered blocks if limits changed.
  function apply(values) {
    const before = JSON.stringify([cache.salt, cache.limits, cache.window])
    Object.assign(cache, values)
    if (JSON.stringify([cache.salt, cache.limits, cache.window]) !== before) blocked.clear()
  }

  function rememberBlock(key, until) {
    if (blocked.size >= BLOCKED_CACHE_MAX) {
      const now = Date.now() / 1000
      blocked = new Map([...blocked].filter(([, t]) => t > now))
      if (blocked.size >= BLOCKED_CACHE_MAX) blocked.clear()
    }
    blocked.set(key, until)
  }

  async function refresh() {
    const now = Date.now() / 1000
    if (now - cache.t < cacheTtl) return
    try {
      // One MGET covers globals + both modes (counts as a single command).
      const keys = [
        'config:kill_all',
        'config:event_mode',
        'config:ratelimit_salt',
        `config:${project}:mode_override`,
        `config:${project}:enabled`,
      ]
      for (const m of ['default', 'demo']) {
        keys.push(`config:${project}:${m}:window`)
        for (const b of Object.keys(buckets)) keys.push(`config:${project}:${m}:${b}`)
      }
      const values = await redis.mget(...keys)
      const data = {}
      keys.forEach((k, i) => { data[k] = values[i] })

      const killed =
        String(data['config:kill_all']) === '1' ||
        String(data[`config:${project}:enabled`]) === '0'

      let mode = data[`config:${project}:mode_override`] || data['config:event_mode'] || 'default'
      if (mode !== 'default' && mode !== 'demo') mode = 'default'
      const salt = data['config:ratelimit_salt'] || ''

      const w = data[`config:${project}:${mode}:window`]
      const window = w != null ? parseInt(w) : defaultWindow

      const limits = {}
      for (const [bucket, def] of Object.entries(buckets)) {
        const v = data[`config:${project}:${mode}:${bucket}`]
        limits[bucket] = v != null ? parseInt(v) : def
      }
      apply({ t: now, salt, killed, limits, window })
    } catch {
      // Config unreachable -> keep defaults, stay live, never block.
      apply({ t: now, killed: false, limits: { ...buckets }, window: defaultWindow })
    }
  }

  return function (bucket) {
    return async function (req, res, next) {
      if (!redis) return next() // limiting disabled (no creds)
      await refresh()

      if (cache.killed) {
        return res.status(503).json({ message: 'This demo is temporarily paused. Check back soon.' })
      }

      const max = cache.limits[bucket] != null ? cache.limits[bucket] : buckets[bucket] || 0
      if (max <= 0) return next()

      // Fixed windows: the key carries the window number, offset per identity, so a
      // counter whose EXPIRE failed is never read again once its window ends.
      const ip = clientIp(req)
      const now = Date.now() / 1000
      const base = `ratelimit:${cache.salt}:${project}:${bucket}:${ip}`
      const over = () => res.status(429).json({ message: 'Rate limit exceeded.', queries_used: max })
      if ((blocked.get(base) || 0) > now) return over() // known over: skip Redis

      const window = Math.max(parseInt(cache.window) || 1, 1)
      const shifted = now + (hash32(ip) % window)
      const left = window - Math.floor(shifted % window) // seconds until this window ends
      const key = `${base}:${Math.floor(shifted / window)}`
      let count
      try {
        count = await redis.incr(key)
        if (count === 1) await redis.expire(key, left + 60)
      } catch {
        return next() // transient Redis error -> fail open
      }
      if (count > max) {
        rememberBlock(base, now + Math.min(left, cacheTtl))
        return over()
      }
      next()
    }
  }
}
