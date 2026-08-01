import Settings from "../settings"
import FloatMsgs from "../components/FloatMsgs"
import { obj2queryString } from ".."
import { baseUrl } from "."

export { baseUrl }
console.log(`Base URL: "${baseUrl}"`)


interface XHRSettings {
    includeToken?: boolean  // default is true
    silentStatuses?: number[]
}

const XHR = {
    baseUrl: `${baseUrl}api/`,
    // Kept as a lightweight UI signal for compatibility with the upstream
    // components. Authentication itself lives only in the HttpOnly cookie.
    token: '',
    csrfToken: '',

    send(method: string, url: string, payload?: object, settings?: XHRSettings) {
        settings = (() => {
            let s: XHRSettings = {
                includeToken: true
            }
            if (settings) {
                Object.assign(s, settings)
            }
            return s
        })()

        return new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest()
            xhr.open(method, this.baseUrl + url)
            xhr.withCredentials = true

            xhr.setRequestHeader('Accept-Language', Settings.lang)
            if (!['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase())) {
                if (this.csrfToken) xhr.setRequestHeader('X-CSRF-Token', this.csrfToken)
            }

            if (typeof payload == 'object') {
                xhr.setRequestHeader("Content-Type", "application/json")
                xhr.send(JSON.stringify(payload))
            } else {
                xhr.send(payload)
            }

            xhr.onload = () => {
                if (xhr.status < 400) {
                    try {
                        let r = JSON.parse(xhr.responseText)
                        if (typeof r?.data?.csrfToken == 'string') {
                            this.csrfToken = r.data.csrfToken
                        }
                        r.code && r.code != 1 && FloatMsgs.show({ type: 'warn', msg: `${r.message} (${r.code})` })
                        resolve(method.toUpperCase() == 'GET' && r?.code == 1 ? r.data : r)
                    } catch (error) {
                        resolve(xhr.responseText)
                    }
                } else {
                    if (xhr.status == 401) {
                        this.token = ''
                        this.csrfToken = ''
                    }
                    const shouldNotify = !settings.silentStatuses?.includes(xhr.status)
                    let errorMessage = xhr.responseText
                    try {
                        const error = JSON.parse(xhr.responseText)
                        error.status = xhr.status
                        errorMessage = error.message || errorMessage
                        if (shouldNotify) {
                            FloatMsgs.show({ type: 'error', msg: `${errorMessage} (${xhr.status})` })
                        }
                        reject(error)
                    } catch (error) {
                        if (shouldNotify) {
                            FloatMsgs.show({ type: 'error', msg: `${errorMessage} (${xhr.status})` })
                        }
                        reject(xhr)
                    }
                }
            }

            xhr.onerror = () => {
                FloatMsgs.show({ type: 'error', msg: '<span class="ui zh">网络错误</span><span class="ui en">Network error</span>' })
                reject(xhr)
            }
            xhr.ontimeout = () => {
                FloatMsgs.show({ type: 'error', msg: '<span class="ui zh">请求超时</span><span class="ui en">Request timed out</span>' })
                reject(xhr)
            }
        });
    },

    get(url: string, payload?: object, settings?: XHRSettings) {
        return this.send('GET', url + obj2queryString(payload), undefined, settings)
    },

    post(url: string, payload?: object, settings?: XHRSettings) {
        return this.send('POST', url, payload, settings)
    },

    put(url: string, payload?: object, settings?: XHRSettings) {
        return this.send('PUT', url, payload, settings)
    },

    delete(url: string, payload?: object, settings?: XHRSettings) {
        return this.send('DELETE', url, payload, settings)
    },
}

export default XHR
