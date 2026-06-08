const NON_JSON_NUMERIC_TOKENS = ['-Infinity', '+Infinity', 'Infinity', 'NaN'] as const

function isTokenBoundary(char: string | undefined): boolean {
  return !char || !/[A-Za-z0-9_$]/.test(char)
}

export function sanitizeNonJsonNumericTokens(text: string): string {
  let result = ''
  let inString = false
  let escaped = false

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]

    if (inString) {
      result += char
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }

    if (char === '"') {
      inString = true
      result += char
      continue
    }

    const token = NON_JSON_NUMERIC_TOKENS.find((candidate) => (
      text.startsWith(candidate, index)
      && isTokenBoundary(text[index - 1])
      && isTokenBoundary(text[index + candidate.length])
    ))

    if (token) {
      result += 'null'
      index += token.length - 1
      continue
    }

    result += char
  }

  return result
}
