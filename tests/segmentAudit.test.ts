import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildSegmentRevisionSummary,
  normalizeOriginalSpeakerFields,
  preserveOriginalSegmentFields,
} from '../src/segmentAudit.ts'

test('normalizeOriginalSpeakerFields repairs a stale first-edit baseline from RTTM evidence', () => {
  const result = normalizeOriginalSpeakerFields(
    {
      id: 's1',
      speakerId: 'C',
      originalSpeakerId: 'B',
    },
    'A',
  )

  assert.equal(result.sourceSpeakerId, 'A')
  assert.equal(result.originalSpeakerId, 'A')
  assert.equal(result.speakerId, 'C')
})

test('preserveOriginalSegmentFields stores original speaker before changing speaker', () => {
  const result = preserveOriginalSegmentFields(
    { id: 's1', speakerId: 'A', text: '原句' },
    { speakerId: 'B' },
    '原句',
  )

  assert.equal(result.originalSpeakerId, 'A')
  assert.equal(result.originalText, '原句')
})

test('preserveOriginalSegmentFields keeps the imported speaker after repeated changes', () => {
  const result = preserveOriginalSegmentFields(
    {
      id: 's1',
      speakerId: 'B',
      sourceSpeakerId: 'A',
      originalSpeakerId: 'A',
      text: '原句',
    },
    { speakerId: 'C' },
    '原句',
  )

  assert.equal(result.originalSpeakerId, undefined)
})

test('preserveOriginalSegmentFields repairs a missing baseline from the imported speaker', () => {
  const result = preserveOriginalSegmentFields(
    { id: 's1', speakerId: 'B', sourceSpeakerId: 'A', text: '原句' },
    { speakerId: 'C' },
    '原句',
  )

  assert.equal(result.originalSpeakerId, 'A')
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

test('buildSegmentRevisionSummary prefers the immutable imported speaker', () => {
  const summary = buildSegmentRevisionSummary({
    id: 's1',
    speakerId: 'C',
    sourceSpeakerId: 'A',
    originalSpeakerId: 'B',
  })

  assert.equal(summary.hasSpeakerChanged, true)
  assert.equal(summary.speakerLine, 'A -> C')
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

test('manual inserted segments never acquire original speaker or text values', () => {
  const result = preserveOriginalSegmentFields(
    {
      id: 'inserted-1',
      speakerId: 'A',
      text: '手工漏句',
      origin: 'manual_insert',
      reviewStatus: 'inserted',
    },
    { speakerId: 'B', text: '修正后的手工漏句' },
    '手工漏句',
  )

  assert.equal(result.origin, 'manual_insert')
  assert.equal(result.sourceSpeakerId, undefined)
  assert.equal(result.originalSpeakerId, undefined)
  assert.equal(result.originalText, undefined)
})

test('normalization repairs stale audit fields on an old manual inserted draft', () => {
  const result = normalizeOriginalSpeakerFields({
    id: 'inserted-1',
    speakerId: 'B',
    sourceSpeakerId: 'A',
    originalSpeakerId: 'A',
    originalText: '旧值',
    reviewStatus: 'corrected',
    notes: 'Manual inserted missing dialogue',
    evidence: { waveform: { suspectedMissing: true } },
  })

  assert.equal(result.origin, 'manual_insert')
  assert.equal(result.reviewStatus, 'inserted')
  assert.equal(result.sourceSpeakerId, undefined)
  assert.equal(result.originalSpeakerId, undefined)
  assert.equal(result.originalText, undefined)
})

test('manual inserted segments do not show original-value revision badges', () => {
  const summary = buildSegmentRevisionSummary({
    id: 'inserted-1',
    speakerId: 'B',
    originalSpeakerId: 'A',
    originalText: '旧值',
    text: '新值',
    origin: 'manual_insert',
    reviewStatus: 'inserted',
  })

  assert.equal(summary.hasSpeakerChanged, false)
  assert.equal(summary.hasTextChanged, false)
  assert.deepEqual(summary.badges, [])
})
