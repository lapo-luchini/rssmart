// Exists only so Chrome on Android considers rssmart installable as an app
// (Add to Home Screen / WebAPK). No offline support is needed or attempted --
// every request just goes straight to the network.
self.addEventListener('fetch', (event) => {
  event.respondWith(fetch(event.request));
});
