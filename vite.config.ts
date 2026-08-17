import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath } from 'node:url'
import { BACKGROUNDS } from './src/config/background-manifest.ts'

const browserMediaReaderStub = fileURLToPath(
  new URL('./src/features/music/unsupported-media-reader.ts', import.meta.url),
)

const STARTUP_MARKER = '<!--elytrue-critical-startup-->'

function criticalStartup(): string {
  const backgrounds = BACKGROUNDS.map(({ id, layout, preview, focus }) => ({
    id,
    layout,
    preview,
    focus,
  }))
  const serialized = JSON.stringify(backgrounds).replaceAll('<', '\\u003c')
  const style = `<style>#initialBackground{position:fixed;inset:0;pointer-events:none;background-color:#ffd1e8;background-image:var(--ely-initial-background,linear-gradient(100deg,#ffd1e8,#b49ac9));background-position:var(--ely-initial-position,50% 50%);background-size:cover}html #bgContainer{background-color:#ffd1e8;background-image:linear-gradient(100deg,#ffd1e8,#b49ac9);background-position:50% 50%;background-size:cover}</style>`
  const script = `<script>(()=>{const a=${serialized},p=l=>a.filter(x=>x.layout===l),r=x=>x[Math.floor(Math.random()*x.length)],s=x=>{x=[...x];for(let i=x.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[x[i],x[j]]=[x[j],x[i]]}return x},b={landscape:r(p('landscape')),portrait:r(p('portrait'))},m=matchMedia('(max-width:720px)').matches?'portrait':'landscape',h=b[m];window.__ELY_VISIT_ASSETS__={backgroundByLayout:b,commentBackgrounds:s(p('portrait')).map(x=>x.preview)};document.documentElement.dataset.initialBackgroundId=h.id;document.documentElement.style.setProperty('--ely-initial-background','url("'+h.preview+'")');document.documentElement.style.setProperty('--ely-initial-position',h.focus);const l=document.createElement('link');l.rel='preload';l.as='image';l.type='image/webp';l.href=h.preview;l.fetchPriority='high';l.dataset.elyInitialBackground=h.id;document.head.append(l);const u='/api/comments/public-fast?count=10',t=performance.now(),d={url:u,public:true,early:true};performance.mark('comments-request-start',{detail:d});performance.mark('api-request-start',{detail:{...d,firstRequest:true,duplicate:false,concurrentDuplicate:false}});window.__ELY_EARLY_COMMENTS__=fetch(u,{credentials:'omit',headers:{Accept:'application/json'}}).then(async e=>{d.ttfb=performance.now()-t;d.status=e.status;d.serverTiming=e.headers.get('Server-Timing')||'';d.cacheStatus=e.headers.get('EO-Cache-Status')||'';d.age=e.headers.get('Age')||'';d.functionRequestId=e.headers.get('Functions-Request-Id')||'';performance.mark('api-response-headers',{detail:d});const text=await e.text();d.total=performance.now()-t;performance.mark('api-request-complete',{detail:d});return{ok:e.ok,status:e.status,statusText:e.statusText,contentType:e.headers.get('content-type')||'',body:text,serverTiming:d.serverTiming,cacheStatus:d.cacheStatus,age:d.age,functionRequestId:d.functionRequestId}}).catch(error=>{d.total=performance.now()-t;d.failed=true;performance.mark('api-request-complete',{detail:d});return{ok:false,status:0,statusText:'',contentType:'',body:'',serverTiming:'',cacheStatus:'',age:'',functionRequestId:'',error}})})();</script>`
  return `${style}${script}`
}

// https://vite.dev/config/
export default defineConfig({
  base: '/',
  // Public assets are staged after Vite finishes so large media files can use
  // hard links instead of consuming a second copy of the build filesystem.
  publicDir: false,
  plugins: [
    {
      name: 'jsmediatags-browser-readers',
      enforce: 'pre',
      resolveId(source, importer) {
        if (
          importer
            ?.replaceAll('\\', '/')
            .endsWith('/node_modules/jsmediatags/build2/jsmediatags.js') &&
          ['./NodeFileReader', './ReactNativeFileReader'].includes(source)
        ) {
          return browserMediaReaderStub
        }
        return null
      },
    },
    {
      name: 'elytrue-critical-startup',
      transformIndexHtml(html) {
        if (!html.includes(STARTUP_MARKER)) {
          throw new Error('Critical startup marker is missing from index.html')
        }
        return html.replace(STARTUP_MARKER, criticalStartup())
      },
    },
    vue({
      template: {
        transformAssetUrls: false,
      },
    }),
  ],
  server: {
    allowedHosts: ['localhost', '127.0.0.1'],
  },
})
