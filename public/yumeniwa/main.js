const iframe = document.querySelector('iframe')
const fullscreenBtn = /** @type {HTMLButtonElement} */ (
  document.querySelector('#fullscreenBtn')
)
let emulateLandscape = false

function updateIframeSize() {
  const winWidth = window.innerWidth
  const winHeight = window.innerHeight
  if ((document.fullscreenElement || emulateLandscape) && winHeight > winWidth) {
    iframe.style.width = `${winHeight}px`
    iframe.style.height = `${winWidth}px`
    iframe.style.transform = 'rotate(90deg)'
    iframe.style.transformOrigin = `${winWidth / 2}px ${winWidth / 2}px`
    fullscreenBtn.style.display = 'none'
  } else {
    iframe.removeAttribute('style')
    fullscreenBtn.removeAttribute('style')
  }
}

function emulateFullscreenLandscape() {
  console.log('rotating the iframe to emulate landscape')
  emulateLandscape = true
  updateIframeSize()
}

function goFullscreen() {
  document.documentElement.requestFullscreen().catch(() => {
    console.warn('Your device does not support fullscreen')
    emulateFullscreenLandscape()
  })
}

fullscreenBtn.addEventListener('click', goFullscreen)
window.addEventListener('resize', () => {
  console.log('window resized')
  updateIframeSize()
})
document.addEventListener('fullscreenchange', () => {
  console.log('fullscreen changed')
  if (document.fullscreenElement) {
    screen.orientation.lock('landscape').catch(() => {
      console.warn('Your device does not support locking screen orientation')
      emulateFullscreenLandscape()
    })
  } else {
    emulateLandscape = false
    updateIframeSize()
    screen.orientation.unlock()
  }
})
