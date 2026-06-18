import test from 'node:test'
import assert from 'node:assert/strict'

import {
  getReviewPrimaryActionOrder,
  REVIEW_PRIMARY_ACTION_LABELS,
} from '../src/reviewPanelActions.ts'

test('selected segment primary actions put speaker and missing insert near pass review', () => {
  assert.deepEqual(getReviewPrimaryActionOrder(true), ['nextPending', 'changeSpeaker', 'insertMissing', 'pass'])
  assert.equal(REVIEW_PRIMARY_ACTION_LABELS.changeSpeaker, '改说话人')
  assert.equal(REVIEW_PRIMARY_ACTION_LABELS.insertMissing, '插入漏句')
})

test('empty inspector only shows navigation action', () => {
  assert.deepEqual(getReviewPrimaryActionOrder(false), ['nextPending'])
})
