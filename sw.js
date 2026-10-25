const C='rsmfceramica-v7';
self.addEventListener('install',e=>{self.skipWaiting();e.waitUntil(caches.open(C).then(c=>c.addAll(['/','/admin/','/produto/','/manifest.webmanifest'])))});
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==C).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',e=>{e.respondWith(fetch(e.request).then(r=>{const copy=r.clone();if(e.request.method==='GET')caches.open(C).then(c=>c.put(e.request,copy));return r}).catch(()=>caches.match(e.request)))});
