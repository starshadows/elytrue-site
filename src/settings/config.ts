export function setCookie(cname: string, cvalue: string, exdays = 999) {
  const d = new Date()
  d.setTime(d.getTime() + exdays * 24 * 60 * 60 * 1000)
  let expires = 'expires=' + d.toUTCString()
  document.cookie = cname + '=' + cvalue + ';' + expires + ';path=/'
}

export function getCookie(cname: string) {
  let name = cname + '='
  let ca = document.cookie.split(';')
  for (let i = 0; i < ca.length; i++) {
    let c = ca[i]
    if (c === undefined) continue
    while (c.charAt(0) == ' ') {
      c = c.substring(1)
    }
    if (c.indexOf(name) == 0) {
      return c.substring(name.length, c.length)
    }
  }
  return ''
}

export function getConfig(key: string) {
  if (localStorage.getItem(key) == null) {
    if (getCookie(key) != '') {
      setConfig(key, getCookie(key))
      document.cookie = `${key}=;expires=${new Date(0).toUTCString()};path=/`
    } else {
      return ''
    }
  }
  return localStorage.getItem(key)
}

export function setConfig(key: string, value: string | boolean | number) {
  if (typeof value != 'string') {
    value = value.toString()
  }
  if (value === '') {
    localStorage.removeItem(key)
  } else {
    localStorage.setItem(key, value)
  }
}
