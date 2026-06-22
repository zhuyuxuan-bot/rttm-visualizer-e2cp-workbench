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

test('non-speaker edits keep the existing review status', () => {
  assert.equal(
    getReviewStatusAfterSegmentPatch(
      { speakerId: 'speaker-a', reviewStatus: 'checked' },
      { text: '修正台词' },
    ),
    'checked',
  )
})
