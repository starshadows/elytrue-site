import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { SITE } from '../src/config/site'

const manifest = {
  name: SITE.name.zh,
  short_name: SITE.name.zh,
  description: SITE.shortDescription.zh,
  start_url: '/',
  theme_color: SITE.themeColor,
  background_color: SITE.backgroundColor,
  display: 'standalone',
  icons: [
    {
      src: SITE.icon.replace(/^\//, ''),
      sizes: '320x320',
      type: 'image/png',
    },
  ],
}

await writeFile(
  resolve('public/index.manifest.json'),
  `${JSON.stringify(manifest, null, 2)}\n`,
  'utf8',
)

console.log('site manifest synchronized from src/config/site.ts')
