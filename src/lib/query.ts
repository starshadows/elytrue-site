export function toQueryString(
  values?: Readonly<Record<string, unknown>>,
): string {
  if (!values) return ''
  const parameters = new URLSearchParams()
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== null && value !== '') {
      parameters.set(key, String(value))
    }
  }
  const query = parameters.toString()
  return query ? `?${query}` : ''
}
