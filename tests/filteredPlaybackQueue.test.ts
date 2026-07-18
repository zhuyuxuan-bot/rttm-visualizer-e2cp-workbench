import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  getFilteredPlaybackSessionAfterSeek,
  getFilteredPlaybackStep,
} from '../src/filteredPlaybackQueue.ts'

const queue = [
  { id: 'a-1', start: 10, end: 12 },
  { id: 'a-2', start: 30, end: 31 },
  { id: 'a-3', start: 45, end: 47 },
]

test('filtered playback continues while inside a queued segment', () => {
  assert.deepEqual(getFilteredPlaybackStep(queue, 10.5), { type: 'continue', segmentId: 'a-1' })
})

test('filtered playback seeks over gaps to the next queued segment', () => {
  assert.deepEqual(getFilteredPlaybackStep(queue, 12.2), { type: 'seek', time: 30, segmentId: 'a-2' })
})

test('filtered playback pauses after the final queued segment during playback', () => {
  assert.deepEqual(getFilteredPlaybackStep(queue, 48), { type: 'pause' })
})

test('filtered playback can wrap to the first queued segment when starting playback again', () => {
  assert.deepEqual(getFilteredPlaybackStep(queue, 48, { wrapToFirst: true }), {
    type: 'seek',
    time: 10,
    segmentId: 'a-1',
  })
})

test('manual timeline seek releases filtered playback control', () => {
  assert.equal(getFilteredPlaybackSessionAfterSeek(true), false)
})

test('dialogue-row seek can preserve filtered speaker playback', () => {
  assert.equal(
    getFilteredPlaybackSessionAfterSeek(true, { preserveFilteredPlayback: true }),
    true,
  )
})
