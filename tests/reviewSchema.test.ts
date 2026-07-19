import assert from 'node:assert/strict'
import { test } from 'node:test'

import { buildEpisodeProject } from '../src/reviewSchema.ts'

test('manual inserted segments export without an original snapshot', () => {
  const project = buildEpisodeProject({
    media: { name: 'ep03.mp4', type: 'video', duration: 60 },
    rttm: { name: 'EP03.rttm' },
    refRTTM: null,
    srt: { name: 'ep03_for_review.srt' },
    speakers: [
      { id: 'speaker-a', name: 'speaker-a', color: '#3388ff', visible: true },
      { id: 'speaker-b', name: 'speaker-b', color: '#ff8833', visible: true },
    ],
    segments: [
      {
        id: 'inserted-1',
        speakerId: 'speaker-b',
        start: 10,
        end: 11,
        text: 'manually inserted dialogue',
        reviewStatus: 'inserted',
        originalSpeakerId: 'speaker-a',
        originalText: 'stale original text',
      },
    ],
    refSegments: [],
    missingRanges: [],
  })

  assert.equal(project.segments[0].origin, 'manual_insert')
  assert.equal(project.segments[0].review_status, 'inserted')
  assert.equal(project.segments[0].original, undefined)
})
