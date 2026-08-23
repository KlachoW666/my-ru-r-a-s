if ('serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations().then(regs => {
    for (let reg of regs) reg.unregister();
  });
  if (typeof caches !== 'undefined') {
    caches.keys().then(keys => keys.forEach(k => caches.delete(k)));
  }
}
export function registerSW() {}
