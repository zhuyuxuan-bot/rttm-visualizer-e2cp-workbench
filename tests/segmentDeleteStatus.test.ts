import assert from 'node:assert/strict'
import { test } from 'node:test'

import { toggleDeletedReviewStatus } from '../src/segmentDeleteStatus.ts'

test('right-click delete toggle preserves and restores the exact prior status', () => {
  const deleted = toggleDeletedReviewStatus({ reviewStatus: 'corrected' as const })

  assert.equal(deleted.reviewStatus, 'deleted')
  assert.equal(deleted.reviewStatusBeforeDelete, 'corrected')

  const restored = toggleDeletedReviewStatus(deleted)
  assert.equal(restored.reviewStatus, 'corrected')
  assert.equal(restored.reviewStatusBeforeDelete, undefined)
})

test('a legacy deleted manual insert restores to inserted', () => {
  const restored = toggleDeletedReviewStatus({
    origin: 'manual_insert' as const,
    reviewStatus: 'deleted' as const,
  })

  assert.equal(restored.reviewStatus, 'inserted')
})
