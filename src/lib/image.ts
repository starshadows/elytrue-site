import FloatMsgs from '../components/FloatMsgs'

function readFile(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.addEventListener('load', () => {
      if (typeof reader.result === 'string') resolve(reader.result)
      else reject(new Error('无法读取图片'))
    })
    reader.addEventListener('error', () => reject(reader.error))
    reader.readAsDataURL(file)
  })
}

function loadImage(source: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.addEventListener('load', () => resolve(image), { once: true })
    image.addEventListener('error', () => reject(new Error('图片加载失败')), {
      once: true,
    })
    image.src = source
  })
}

export async function resizeImage(
  source: Blob | string,
  aspectRatio?: number,
  maxPixels?: number,
): Promise<string> {
  if (source instanceof Blob && !source.type.startsWith('image/')) {
    FloatMsgs.show({
      type: 'error',
      msg: '<span class="ui zh">图片无效</span><span class="ui en">Invalid image</span>',
    })
    throw new Error('图片无效')
  }
  const image = await loadImage(
    typeof source === 'string' ? source : await readFile(source),
  )
  let width = image.width
  let height = image.height
  if (aspectRatio) {
    if (width / height > aspectRatio) width = height * aspectRatio
    else height = width / aspectRatio
  }
  if (maxPixels && width * height > maxPixels) {
    const scale = Math.sqrt(maxPixels / (width * height))
    width *= scale
    height *= scale
  }
  width = Math.round(width)
  height = Math.round(height)
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) throw new Error('浏览器不支持图片处理')
  if (aspectRatio && image.width / image.height > aspectRatio) {
    context.drawImage(
      image,
      (image.width - image.height * aspectRatio) / 2,
      0,
      image.height * aspectRatio,
      image.height,
      0,
      0,
      width,
      height,
    )
  } else if (aspectRatio) {
    context.drawImage(
      image,
      0,
      (image.height - image.width / aspectRatio) / 2,
      image.width,
      image.width / aspectRatio,
      0,
      0,
      width,
      height,
    )
  } else {
    context.drawImage(image, 0, 0, width, height)
  }
  return canvas.toDataURL('image/jpeg')
}
