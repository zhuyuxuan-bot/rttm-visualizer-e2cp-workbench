import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildSegmentRevisionSummary,
  preserveOriginalSegmentFields,
} from '../src/segmentAudit.ts'

test('preserveOriginalSegmentFields stores original speaker before changing speaker', () => {
  const result = preserveOriginalSegmentFields(
    { id: 's1', speakerId: 'A', text: '原句' },
    { speakerId: 'B' },
    '原句',
  )

  assert.equal(result.originalSpeakerId, 'A')
  assert.equal(result.originalText, '原句')
})

test('buildSegmentRevisionSummary reports speaker and text changes', () => {
  const summary = buildSegmentRevisionSummary(
    {
      id: 's1',
      speakerId: 'B',
      text: '新句',
      originalSpeakerId: 'A',
      originalText: '原句',
    },
    {
      originalSpeakerName: '角色A',
      currentSpeakerName: '角色B',
      currentText: '新句',
    },
  )

  assert.equal(summary.hasSpeakerChanged, true)
  assert.equal(summary.hasTextChanged, true)
  assert.deepEqual(summary.badges, ['说话人已改', '文本已改'])
  assert.equal(summary.speakerLine, '角色A -> 角色B')
  assert.equal(summary.textLine, '原句 -> 新句')
})

test('buildSegmentRevisionSummary stays quiet when current values match originals', () => {
  const summary = buildSegmentRevisionSummary(
    {
      id: 's1',
      speakerId: 'A',
      text: '原句',
      originalSpeakerId: 'A',
      originalText: '原句',
    },
    {
      currentSpeakerName: 'A',
      currentText: '原句',
    },
  )

  assert.equal(summary.hasSpeakerChanged, false)
  assert.equal(summary.hasTextChanged, false)
  assert.deepEqual(summary.badges, [])
})
