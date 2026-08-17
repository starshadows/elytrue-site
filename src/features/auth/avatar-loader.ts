const loadedImages = new Map<string, Promise<HTMLImageElement>>()

export function preloadAvatar(source: string): Promise<HTMLImageElement> {
  const existing = loadedImages.get(source)
  if (existing) return existing

  const image = new Image()
  const request = new Promise<HTMLImageElement>((resolve, reject) => {
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('头像加载失败'))
    image.src = source
  }).catch((error: unknown) => {
    loadedImages.delete(source)
    throw error
  })
  loadedImages.set(source, request)
  return request
}
