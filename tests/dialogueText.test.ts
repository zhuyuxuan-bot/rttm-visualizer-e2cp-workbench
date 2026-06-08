import test from 'node:test'
import assert from 'node:assert/strict'

import { stripSpeakerPrefix } from '../src/dialogueText.ts'

test('stripSpeakerPrefix removes a known Chinese speaker prefix before display', () => {
  assert.equal(stripSpeakerPrefix('丁仪：结婚多久了', ['丁仪', '汪淼']), '结婚多久了')
})

test('stripSpeakerPrefix supports ASCII colon prefixes', () => {
  assert.equal(stripSpeakerPrefix('Wang Miao: eight years', ['Wang Miao']), 'eight years')
})

test('stripSpeakerPrefix keeps non-speaker colon text unchanged', () => {
  assert.equal(stripSpeakerPrefix('注意：这里不是说话人前缀', ['丁仪', '汪淼']), '注意：这里不是说话人前缀')
})
