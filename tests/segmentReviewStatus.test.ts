import assert from 'node:assert/strict'
import { test } from 'node:test'
import { getReviewStatusAfterSegmentPatch } from '../src/segmentReviewStatus.ts'

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
