export function stripSpeakerPrefix(text: string, speakerLabels: string[]): string {
  const value = text.trim()
  if (!value) return value

  const fullWidthIndex = value.indexOf('：')
  const asciiIndex = value.indexOf(':')
  const colonIndex = [fullWidthIndex, asciiIndex]
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0]

  if (colonIndex === undefined || colonIndex > 40) return value

  const prefix = value.slice(0, colonIndex).trim()
  const body = value.slice(colonIndex + 1).trim()
  if (!prefix || !body) return value

  const knownLabels = new Set(
    speakerLabels
      .map((label) => label.trim())
      .filter(Boolean),
  )

  return knownLabels.has(prefix) ? body : value
}
