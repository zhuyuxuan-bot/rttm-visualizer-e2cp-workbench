import assert from 'node:assert/strict'
import test from 'node:test'

import {
  activateReviewRound,
  appendReviewEvent,
  buildReviewPackage,
  createReviewWorkspace,
  ensureReviewSegments,
  getLatestReviewEvent,
  parseReviewPackage,
  summarizeReviewWorkspace,
  type ReviewEvent,
  type ReviewValueSnapshot,
} from '../src/reviewWorkflow.ts'

const original: ReviewValueSnapshot = {
  speaker_id: 'A',
  speaker_name: '汪淼',
  text: '科学边界',
  start_ms: 1000,
  end_ms: 2200,
}

test('复核事件采用追加式记录并更新当前状态', () => {
  const workspace = createReviewWorkspace({
    episodeId: '03',
    segmentIds: ['seg-1', 'seg-2'],
    reviewerName: '李明',
    now: '2026-07-19T00:00:00.000Z',
  })
  const event: ReviewEvent = {
    id: 'event-1',
    round_id: workspace.active_round_id,
    segment_id: 'seg-1',
    actor: workspace.rounds[0].reviewer,
    action: 'change_proposed',
    issue_types: ['speaker', 'text'],
    before: original,
    proposed_after: { ...original, speaker_id: 'B', speaker_name: '常伟思', text: '你们科学边界' },
    reason: '画面与声纹均指向常伟思',
    evidence_time_ms: 1320,
    created_at: '2026-07-19T00:01:00.000Z',
  }
  const next = appendReviewEvent(workspace, event)

  assert.equal(workspace.events.length, 0)
  assert.equal(next.events.length, 1)
  assert.equal(next.segment_states['seg-1'].status, 'awaiting_annotator')
  assert.equal(getLatestReviewEvent(next, 'seg-1')?.reason, event.reason)
})

test('复核统计覆盖未检查、有异议、待回改和已解决', () => {
  let workspace = createReviewWorkspace({
    episodeId: '03',
    segmentIds: ['a', 'b', 'c'],
    reviewerName: '李明',
    now: '2026-07-19T00:00:00.000Z',
  })
  workspace = appendReviewEvent(workspace, {
    id: 'approved', round_id: 'round-1', segment_id: 'a', actor: workspace.rounds[0].reviewer,
    action: 'approved', issue_types: [], before: original, reason: '无异议', created_at: '2026-07-19T00:01:00.000Z',
  })
  workspace = appendReviewEvent(workspace, {
    id: 'issue', round_id: 'round-1', segment_id: 'b', actor: workspace.rounds[0].reviewer,
    action: 'issue_reported', issue_types: ['timing'], before: original, reason: '结束时间过长', created_at: '2026-07-19T00:02:00.000Z',
  })
  const summary = summarizeReviewWorkspace(workspace)
  assert.deepEqual(
    { total: summary.total, unreviewed: summary.unreviewed, approved: summary.approved, issueOpen: summary.issueOpen },
    { total: 3, unreviewed: 1, approved: 1, issueOpen: 1 },
  )
})

test('复核包可无损保存和恢复', () => {
  const workspace = ensureReviewSegments(createReviewWorkspace({
    episodeId: '03', segmentIds: ['seg-1'], reviewerName: '李明', now: '2026-07-19T00:00:00.000Z',
  }), ['seg-1', 'seg-2'])
  const reviewPackage = buildReviewPackage({
    project: { schema_version: 'e2cp.review_project.v1', segments: [] },
    review: workspace,
    status: 'draft',
    now: '2026-07-19T00:03:00.000Z',
  })
  const restored = parseReviewPackage(JSON.stringify(reviewPackage))
  assert.equal(restored?.review.episode_id, '03')
  assert.equal(restored?.review.segment_states['seg-2'].status, 'unreviewed')
  assert.equal(restored?.package_status, 'draft')
})

test('拒绝缺少复核记录的伪复核包', () => {
  assert.throws(
    () => parseReviewPackage(JSON.stringify({ schema_version: 'e2cp.review_package.v1', package_status: 'draft', review: {} })),
    /review/,
  )
})

test('切换复核轮次会保留旧轮次并激活新轮次', () => {
  const workspace = createReviewWorkspace({
    episodeId: '03', segmentIds: ['seg-1'], reviewerName: '李明', now: '2026-07-19T00:00:00.000Z',
  })
  const next = activateReviewRound(workspace, {
    roundNumber: 2,
    reviewerName: '王芳',
    now: '2026-07-20T00:00:00.000Z',
  })

  assert.equal(next.active_round_id, 'round-2')
  assert.equal(next.rounds.length, 2)
  assert.equal(next.rounds[0].reviewer.name, '李明')
  assert.equal(next.rounds[1].reviewer.name, '王芳')
})
