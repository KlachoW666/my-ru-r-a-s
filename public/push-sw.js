/* eslint-disable no-restricted-globals */
// Service Worker for Web Push notifications.
// Registered from the main app; receives push events from the server
// (squeaker WebPushService) and shows browser notifications.

/**
 * Action routes currently held by an open, watching client (see
 * holdBattleWinNotification in useBattleGame.ts). The backend already delays a
 * game-win Web Push by its best-effort estimate of the client's remaining
 * reveal animation (`notify_delay_ms`), but that's a static guess computed
 * before the round even reaches the client — network jitter or a throttled
 * background tab can still let the push win the race (TEAMDEV-394). This is
 * the client-side gate that closes it: a push for a held route waits for the
 * matching 'release-notification-route' message (or its own safety-net
 * timeout) before showNotification runs.
 */
const heldRoutes = new Map()

// Safety net if a hold is never released (page closed before cleanup ran, a
// message lost) — comfortably above the longest normal-mode last round (spin
// 6300ms + reveal 1200ms + buffer 500ms).
const HELD_ROUTE_MAX_WAIT_MS = 15000

/**
 * Both sides of the gate build this key from the same `/crate-pvp/{battleId}`
 * template, but the client's hold and the server's push payload are two
 * independent code paths — a query string or trailing slash added to either
 * one shouldn't silently defeat the `Map` lookup, so both are normalized
 * before use as a key.
 */
function normalizeRoute(route) {
  return route.split('?')[0].replace(/\/+$/, '')
}

function holdRoute(route) {
  const key = normalizeRoute(route)
  if (heldRoutes.has(key)) return
  let resolve
  const promise = new Promise(res => {
    resolve = res
  })
  const timer = setTimeout(() => releaseRoute(key), HELD_ROUTE_MAX_WAIT_MS)
  heldRoutes.set(key, { promise, resolve, timer })
}

function releaseRoute(route) {
  const key = normalizeRoute(route)
  const entry = heldRoutes.get(key)
  if (!entry) return
  clearTimeout(entry.timer)
  heldRoutes.delete(key)
  entry.resolve()
}

self.addEventListener('message', event => {
  const msg = event.data
  if (!msg || typeof msg.route !== 'string') return
  if (msg.type === 'hold-notification-route') holdRoute(msg.route)
  else if (msg.type === 'release-notification-route') releaseRoute(msg.route)
})

self.addEventListener('push', event => {
  let title = 'Kaban'
  let body = ''
  let data = {}

  if (event.data) {
    try {
      const payload = event.data.json()
      const notification = payload.data ?? payload
      title = notification.title ?? title
      body = notification.description ?? ''

      let url = '/'
      let promoCode = ''
      try {
        const action = JSON.parse(notification.actionPayloadJson || '{}')
        url = action.route || action.path || action.url || notification.actionUrl || '/'
        // ACTIVATION notifications carry a promo code; the app auto-redeems it
        // on click via the `promo_activate` query param (see App.vue).
        if (typeof action.promoCode === 'string' && action.promoCode) {
          promoCode = action.promoCode
        }
      } catch {
        url = notification.actionUrl || '/'
      }

      data = { url, promoCode, notificationId: notification.id ?? null, notification }
    } catch {
      body = event.data.text()
    }
  }

  const show = () =>
    self.registration.showNotification(title, {
      body,
      icon: '/logo-symbol.png',
      badge: '/logo-symbol.png',
      data,
    })

  const held = data.url ? heldRoutes.get(normalizeRoute(data.url)) : undefined
  event.waitUntil(held ? held.promise.then(show) : show())
})

self.addEventListener('notificationclick', event => {
  event.notification.close()

  const data = event.notification.data ?? {}
  let route = data.url ?? '/'
  // Append the one-shot auto-activation params so the app redeems the promo on
  // arrival. Survives both transports: the focused-tab BroadcastChannel message
  // and the fresh `openWindow` URL.
  if (data.promoCode) {
    const sep = route.includes('?') ? '&' : '?'
    route += `${sep}promo_activate=${encodeURIComponent(data.promoCode)}`
    if (data.notificationId != null) {
      route += `&nid=${encodeURIComponent(data.notificationId)}`
    }
  }

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
      const existing = clients.find(c => c.url.includes(self.location.origin))
      if (existing) {
        return existing.focus().then(() => {
          const bc = new BroadcastChannel('push-navigate')
          bc.postMessage({ url: route })
          bc.close()
        })
      }
      return self.clients.openWindow(route)
    }),
  )
})
