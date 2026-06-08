import test from 'node:test'
import assert from 'node:assert/strict'

import { sanitizeNonJsonNumericTokens } from '../src/candidateJsonSanitizer.ts'

test('sanitizeNonJsonNumericTokens converts bare NaN values to null', () => {
  const sanitized = sanitizeNonJsonNumericTokens('{"top_5_speakers":[{"role":"丁仪","sim": NaN}]}')

  assert.deepEqual(JSON.parse(sanitized), {
    top_5_speakers: [{ role: '丁仪', sim: null }],
  })
})

test('sanitizeNonJsonNumericTokens does not change NaN inside strings', () => {
  const sanitized = sanitizeNonJsonNumericTokens('{"text":"NaN 是文件里的字面文本","sim": NaN}')

  assert.deepEqual(JSON.parse(sanitized), {
    text: 'NaN 是文件里的字面文本',
    sim: null,
  })
})

test('sanitizeNonJsonNumericTokens converts bare Infinity values to null', () => {
  const sanitized = sanitizeNonJsonNumericTokens('{"scores":[Infinity,-Infinity,+Infinity]}')

  assert.deepEqual(JSON.parse(sanitized), {
    scores: [null, null, null],
  })
})
