// @ts-check
import * as fs from 'fs'
import * as path from 'path'

const argUrl = (() => {
    if (process.argv.length > 2) {
        const url = process.argv[2]
        return url.endsWith('/') ? url : (url + '/')
    }
})()

const baseUrl = argUrl || 'https://haojiezhe12345.top:82/madohomu/'
const bgBaseUrl = argUrl ? (argUrl + 'bg/') : 'https://assets.madohomu.haojiezhe12345.top/bg/'

const replaceDir = '../dist'

const replaceDict = {
    'bg/': `${bgBaseUrl}`,
    'api/': `${baseUrl}api/`,
    'media/': `${baseUrl}media/`,
    'res/': `${baseUrl}res/`,
    '<!-- Insert base URL here -->': /*html*/`
        <script>
            window.baseUrl = "${baseUrl}"
            window.bgBaseUrl = "${bgBaseUrl}"
        </script>
    `,
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
