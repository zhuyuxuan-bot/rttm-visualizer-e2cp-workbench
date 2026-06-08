import test from 'node:test'
import assert from 'node:assert/strict'

import {
  applyMissingTimePoint,
  applyMissingTimeRange,
  formatDraftTime,
} from '../src/missingInsertSelection.ts'

test('formatDraftTime keeps millisecond precision for review fields', () => {
  assert.equal(formatDraftTime(124.3), '124.300')
})

test('applyMissingTimePoint writes the requested start time', () => {
  const result = applyMissingTimePoint({ start: '', end: '' }, 'start', 124.321)

  assert.deepEqual(result.draft, { start: '124.321', end: '' })
})

test('applyMissingTimePoint writes the requested end time and normalizes reversed ranges', () => {
  const result = applyMissingTimePoint({ start: '130.000', end: '' }, 'end', 124.5)

  assert.deepEqual(result.draft, { start: '124.500', end: '130.000' })
})

test('applyMissingTimeRange fills both fields from drag selection in chronological order', () => {
  const result = applyMissingTimeRange({ start: '', end: '' }, 205.75, 202.125)

  assert.deepEqual(result.draft, { start: '202.125', end: '205.750' })
})
