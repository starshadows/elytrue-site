// @ts-expect-error
interface ApiResponse<T = null> {
  code: number
  message: string
  data?: T | null
}
