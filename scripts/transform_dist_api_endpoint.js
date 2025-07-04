// @ts-check
import * as fs from 'fs'
import * as path from 'path'

const baseUrl = (() => {
    let url = 'https://haojiezhe12345.top:82/madohomu/'
    if (process.argv.length > 2) {
        url = process.argv[2]
    }
    if (!url.endsWith('/')) {
        url += '/'
    }
    return url
})()

const replaceDir = '../dist'

const replaceDict = {
    'bg/': `${baseUrl}bg/`,
    'api/': `${baseUrl}api/`,
    'media/': `${baseUrl}media/`,
    'res/': `${baseUrl}res/`,
    '<!-- Insert base URL here -->': `<script> window.baseUrl = "${baseUrl}" </script>`,
    '"/madohomu"': '"/?no-redirect"',
}

const maxKeyLength = Math.max(...Object.keys(replaceDict).map(key => key.length))
for (const [key, value] of Object.entries(replaceDict)) {
    console.log(`${`"${key}"`.padEnd(maxKeyLength + 2, ' ')} -> "${value}"`)
}

for (const file of fs.readdirSync(replaceDir)) {
    if (file.startsWith('index')) {
        replaceFile(path.join(replaceDir, file))
    }
}

/** @param {string} filePath */
function replaceFile(filePath) {
    console.log(filePath)

    let fileTxt = fs.readFileSync(filePath, 'utf-8')
    fileTxt = fileTxt.replaceAll('\r\n', '\n').replaceAll('\r', '\n').replaceAll('\n', '\r\n')

    for (const [key, value] of Object.entries(replaceDict)) {
        fileTxt = fileTxt.replaceAll(key, value)
    }
    fs.writeFileSync(filePath, fileTxt, 'utf-8')
}
