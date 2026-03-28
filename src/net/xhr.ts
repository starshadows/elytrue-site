import Settings from "../settings"
import FloatMsgs from "../components/FloatMsgs"
import { obj2queryString } from ".."
import { baseUrl } from "."

export { baseUrl }
console.log(`Base URL: "${baseUrl}"`)


interface XHRSettings {
    includeToken: boolean  // default is true
}

const XHR = {
    baseUrl: `${baseUrl}api/`,
    token: '',

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

            if (this.token && settings.includeToken) {
                xhr.setRequestHeader('Authorization', this.token)
                xhr.setRequestHeader('token', this.token)
            }

            xhr.setRequestHeader('Accept-Language', Settings.lang)

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
                        r.code && r.code != 1 && FloatMsgs.show({ type: 'warn', msg: `${r.message} (${r.code})` })
                        resolve(r)
                    } catch (error) {
                        resolve(xhr.responseText)
                    }
                } else {
                    if (xhr.status == 401) this.token = ''
                    FloatMsgs.show({ type: 'error', msg: `${xhr.responseText} (${xhr.status})` })
                    try {
                        reject(JSON.parse(xhr.responseText))
                    } catch (error) {
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
