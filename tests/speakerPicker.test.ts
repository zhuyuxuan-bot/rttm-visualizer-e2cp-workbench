import assert from 'node:assert/strict'
import test from 'node:test'
import {
  getSpeakerPickerPosition,
  orderSpeakerPickerOptions,
  updateRecentSpeakerIds,
} from '../src/speakerPicker.ts'

test('speaker picker opens above the anchor when the lower space is insufficient', () => {
  assert.deepEqual(
    getSpeakerPickerPosition(
      { left: 900, right: 980, top: 650, bottom: 690 },
      { width: 1200, height: 720 },
      { width: 360, height: 320 },
    ),
    { x: 830, y: 322 },
  )
})

test('speaker picker puts recent speakers first and supports name or id search', () => {
  const speakers = [
    { id: 'wang_miao', name: '汪淼' },
    { id: 'ding_yi', name: '丁仪' },
    { id: 'yang_dong', name: '杨冬' },
  ]
  assert.deepEqual(
    orderSpeakerPickerOptions(speakers, ['yang_dong', 'ding_yi'], '').map((speaker) => speaker.id),
    ['yang_dong', 'ding_yi', 'wang_miao'],
  )
  assert.deepEqual(
    orderSpeakerPickerOptions(speakers, [], 'wang').map((speaker) => speaker.id),
    ['wang_miao'],
  )
})

test('recent speaker list is unique and capped', () => {
  assert.deepEqual(updateRecentSpeakerIds(['a', 'b', 'c', 'd', 'e'], 'c'), ['c', 'a', 'b', 'd', 'e'])
  assert.deepEqual(updateRecentSpeakerIds(['a', 'b', 'c'], 'd', 3), ['d', 'a', 'b'])
})
