import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  getReviewStatusAfterPass,
  getReviewStatusAfterSegmentPatch,
} from '../src/segmentReviewStatus.ts'

test('changing speaker automatically marks a checked segment as corrected', () => {
  assert.equal(
    getReviewStatusAfterSegmentPatch(
      { speakerId: 'speaker-a', reviewStatus: 'checked' },
      { speakerId: 'speaker-b' },
    ),
    'corrected',
  )
})

test('changing text automatically marks a checked segment as corrected', () => {
  assert.equal(
    getReviewStatusAfterSegmentPatch(
      { speakerId: 'speaker-a', text: '原台词', reviewStatus: 'checked' },
      { text: '修正台词' },
    ),
    'corrected',
  )
})

test('saving unchanged text keeps the existing review status', () => {
  assert.equal(
    getReviewStatusAfterSegmentPatch(
      { speakerId: 'speaker-a', text: '原台词', reviewStatus: 'checked' },
      { text: '原台词' },
    ),
    'checked',
  )
})

test('passing a pending segment marks it checked', () => {
  assert.equal(getReviewStatusAfterPass('pending'), 'checked')
  assert.equal(getReviewStatusAfterPass(undefined), 'checked')
})

test('passing preserves meaningful non-pending review states', () => {
  for (const status of ['checked', 'corrected', 'inserted', 'deleted', 'uncertain'] as const) {
    assert.equal(getReviewStatusAfterPass(status), status)
  }
})

test('changing a manual inserted segment keeps it inserted', () => {
  const segment = {
    speakerId: 'speaker-a',
    text: '漏句',
    origin: 'manual_insert' as const,
    reviewStatus: 'inserted' as const,
  }

  assert.equal(getReviewStatusAfterSegmentPatch(segment, { speakerId: 'speaker-b' }), 'inserted')
  assert.equal(getReviewStatusAfterSegmentPatch(segment, { text: '修正漏句' }), 'inserted')
})

test('old manual inserted segments marked corrected are repaired on the next edit', () => {
  assert.equal(
    getReviewStatusAfterSegmentPatch(
      {
        speakerId: 'speaker-a',
        reviewStatus: 'corrected',
        notes: 'Manual inserted missing dialogue',
        evidence: { waveform: { suspectedMissing: true } },
      },
      { speakerId: 'speaker-b' },
    ),
    'inserted',
  )
})

test('a manual inserted segment can still be explicitly deleted', () => {
  assert.equal(
    getReviewStatusAfterSegmentPatch(
      { speakerId: 'speaker-a', origin: 'manual_insert', reviewStatus: 'inserted' },
      { reviewStatus: 'deleted' },
    ),
    'deleted',
  )
})
