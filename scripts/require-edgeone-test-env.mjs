const required = ['EDGEONE_TEST_PROJECT_ID', 'EDGEONE_TEST_TOKEN']
const missing = required.filter((name) => !process.env[name])

if (missing.length > 0) {
  console.error(`EdgeOne contract gate requires: ${missing.join(', ')}`)
  process.exitCode = 1
}
