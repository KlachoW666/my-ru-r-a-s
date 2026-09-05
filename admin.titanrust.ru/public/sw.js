'use strict';

// The admin frontend is shipped as compiled files and occasionally receives
// targeted fixes without changing Vite's hashed filenames. Pre-caching those
// URLs made browsers execute an obsolete bundle after a deployment. The admin
// panel does not need offline mode, so this worker only removes caches created
// by older Workbox versions and lets every request use the network normally.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(names => Promise.all(names.map(name => caches.delete(name))))
      .then(() => self.clients.claim())
  );
});
