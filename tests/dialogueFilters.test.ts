import test from 'node:test'
import assert from 'node:assert/strict'

import { filterDialogueRows } from '../src/dialogueFilters.ts'

const rows = [
  { segment: { id: '1', speakerId: '丁仪', reviewStatus: 'pending' }, index: 0 },
  { segment: { id: '2', speakerId: '汪淼', reviewStatus: 'checked' }, index: 1 },
  { segment: { id: '3', speakerId: '丁仪', reviewStatus: 'corrected' }, index: 2 },
  { segment: { id: '4', speakerId: '汪淼' }, index: 3 },
]

test('filterDialogueRows combines status and speaker filters', () => {
  const result = filterDialogueRows(rows, {
    status: 'pending',
    speakerId: '丁仪',
  })

  assert.deepEqual(result.map(({ segment }) => segment.id), ['1'])
})

test('filterDialogueRows treats missing review status as pending', () => {
  const result = filterDialogueRows(rows, {
    status: 'pending',
    speakerId: '汪淼',
  })

  assert.deepEqual(result.map(({ segment }) => segment.id), ['4'])
})

test('filterDialogueRows can independently show all speakers for one status', () => {
  const result = filterDialogueRows(rows, {
    status: 'all',
    speakerId: '丁仪',
  })

  assert.deepEqual(result.map(({ segment }) => segment.id), ['1', '3'])
})
