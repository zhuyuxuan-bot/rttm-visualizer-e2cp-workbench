export type ReviewIssueType = 'speaker' | 'text' | 'timing' | 'extra' | 'missing' | 'other'

export type ReviewSegmentStatus =
  | 'unreviewed'
  | 'approved'
  | 'issue_open'
  | 'awaiting_annotator'
  | 'annotator_replied'
  | 'resolved'

export type ReviewActorRole = 'reviewer' | 'annotator' | 'system'

export type ReviewAction =
  | 'approved'
  | 'issue_reported'
  | 'change_proposed'
  | 'annotator_replied'
  | 'resolved'
  | 'reopened'

export interface ReviewActor {
  id: string
  name: string
  role: ReviewActorRole
}

export interface ReviewValueSnapshot {
  speaker_id: string
  speaker_name: string
  text: string
  start_ms: number
  end_ms: number
}

export interface ReviewEvent {
  id: string
  round_id: string
  segment_id: string
  actor: ReviewActor
  action: ReviewAction
  issue_types: ReviewIssueType[]
  before: ReviewValueSnapshot
  proposed_after?: ReviewValueSnapshot
  reason: string
  evidence_time_ms?: number
  created_at: string
}

export interface ReviewRound {
  id: string
  number: number
  reviewer: ReviewActor
  created_at: string
}

export interface ReviewSegmentState {
  status: ReviewSegmentStatus
  latest_event_id?: string
  updated_at?: string
}

export interface ReviewWorkspace {
  schema_version: 'e2cp.review_trace.v1'
  episode_id: string
  active_round_id: string
  rounds: ReviewRound[]
  segment_states: Record<string, ReviewSegmentState>
  events: ReviewEvent[]
}

export interface ReviewPackage<TProject = unknown> {
  schema_version: 'e2cp.review_package.v1'
  package_status: 'draft' | 'submitted'
  exported_at: string
  project: TProject
  review: ReviewWorkspace
}

export interface ReviewSummary {
  total: number
  unreviewed: number
  approved: number
  issueOpen: number
  awaitingAnnotator: number
  annotatorReplied: number
  resolved: number
  reviewed: number
}

const REVIEW_STATUSES: ReviewSegmentStatus[] = [
  'unreviewed',
  'approved',
  'issue_open',
  'awaiting_annotator',
  'annotator_replied',
  'resolved',
]

const REVIEW_ACTIONS: ReviewAction[] = [
  'approved',
  'issue_reported',
  'change_proposed',
  'annotator_replied',
  'resolved',
  'reopened',
]

function statusAfterAction(action: ReviewAction): ReviewSegmentStatus {
  switch (action) {
    case 'approved': return 'approved'
    case 'issue_reported': return 'issue_open'
    case 'change_proposed': return 'awaiting_annotator'
    case 'annotator_replied': return 'annotator_replied'
    case 'resolved': return 'resolved'
    case 'reopened': return 'issue_open'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function createReviewWorkspace(input: {
  episodeId: string
  segmentIds: string[]
  reviewerName: string
  reviewerId?: string
  roundNumber?: number
  now?: string
}): ReviewWorkspace {
  const now = input.now ?? new Date().toISOString()
  const roundNumber = Math.max(1, Math.round(input.roundNumber ?? 1))
  const reviewer: ReviewActor = {
    id: input.reviewerId?.trim() || `reviewer-${input.reviewerName.trim() || 'anonymous'}`,
    name: input.reviewerName.trim() || '未命名复核人',
    role: 'reviewer',
  }
  const roundId = `round-${roundNumber}`
  return {
    schema_version: 'e2cp.review_trace.v1',
    episode_id: input.episodeId,
    active_round_id: roundId,
    rounds: [{ id: roundId, number: roundNumber, reviewer, created_at: now }],
    segment_states: Object.fromEntries(input.segmentIds.map((id) => [id, { status: 'unreviewed' }])),
    events: [],
  }
}

export function ensureReviewSegments(workspace: ReviewWorkspace, segmentIds: string[]): ReviewWorkspace {
  const missingIds = segmentIds.filter((id) => !workspace.segment_states[id])
  if (missingIds.length === 0) return workspace
  return {
    ...workspace,
    segment_states: {
      ...workspace.segment_states,
      ...Object.fromEntries(missingIds.map((id) => [id, { status: 'unreviewed' as const }])),
    },
  }
}

export function activateReviewRound(workspace: ReviewWorkspace, input: {
  roundNumber: number
  reviewerName: string
  reviewerId?: string
  now?: string
}): ReviewWorkspace {
  const roundNumber = Math.max(1, Math.round(input.roundNumber))
  const roundId = `round-${roundNumber}`
  const reviewerName = input.reviewerName.trim() || '未命名复核人'
  const existingRound = workspace.rounds.find((round) => round.id === roundId)

  if (existingRound) {
    const reviewerId = input.reviewerId?.trim() || existingRound.reviewer.id
    if (
      workspace.active_round_id === roundId &&
      existingRound.reviewer.name === reviewerName &&
      existingRound.reviewer.id === reviewerId
    ) return workspace

    return {
      ...workspace,
      active_round_id: roundId,
      rounds: workspace.rounds.map((round) => round.id === roundId
        ? { ...round, reviewer: { id: reviewerId, name: reviewerName, role: 'reviewer' } }
        : round),
    }
  }

  return {
    ...workspace,
    active_round_id: roundId,
    rounds: [
      ...workspace.rounds,
      {
        id: roundId,
        number: roundNumber,
        reviewer: {
          id: input.reviewerId?.trim() || `reviewer-${reviewerName}`,
          name: reviewerName,
          role: 'reviewer',
        },
        created_at: input.now ?? new Date().toISOString(),
      },
    ],
  }
}

export function appendReviewEvent(workspace: ReviewWorkspace, event: ReviewEvent): ReviewWorkspace {
  if (workspace.events.some((item) => item.id === event.id)) {
    throw new Error(`复核事件 ID 重复：${event.id}`)
  }
  if (!workspace.rounds.some((round) => round.id === event.round_id)) {
    throw new Error(`复核轮次不存在：${event.round_id}`)
  }
  return {
    ...workspace,
    segment_states: {
      ...workspace.segment_states,
      [event.segment_id]: {
        status: statusAfterAction(event.action),
        latest_event_id: event.id,
        updated_at: event.created_at,
      },
    },
    events: [...workspace.events, event],
  }
}

export function getLatestReviewEvent(workspace: ReviewWorkspace, segmentId: string): ReviewEvent | null {
  for (let index = workspace.events.length - 1; index >= 0; index -= 1) {
    if (workspace.events[index].segment_id === segmentId) return workspace.events[index]
  }
  return null
}

export function summarizeReviewWorkspace(workspace: ReviewWorkspace): ReviewSummary {
  const summary: ReviewSummary = {
    total: 0,
    unreviewed: 0,
    approved: 0,
    issueOpen: 0,
    awaitingAnnotator: 0,
    annotatorReplied: 0,
    resolved: 0,
    reviewed: 0,
  }
  for (const state of Object.values(workspace.segment_states)) {
    summary.total += 1
    if (state.status === 'unreviewed') summary.unreviewed += 1
    if (state.status === 'approved') summary.approved += 1
    if (state.status === 'issue_open') summary.issueOpen += 1
    if (state.status === 'awaiting_annotator') summary.awaitingAnnotator += 1
    if (state.status === 'annotator_replied') summary.annotatorReplied += 1
    if (state.status === 'resolved') summary.resolved += 1
  }
  summary.reviewed = summary.total - summary.unreviewed
  return summary
}

export function buildReviewPackage<TProject>(input: {
  project: TProject
  review: ReviewWorkspace
  status: 'draft' | 'submitted'
  now?: string
}): ReviewPackage<TProject> {
  return {
    schema_version: 'e2cp.review_package.v1',
    package_status: input.status,
    exported_at: input.now ?? new Date().toISOString(),
    project: input.project,
    review: input.review,
  }
}

export function parseReviewPackage(raw: string): ReviewPackage | null {
  const parsed = JSON.parse(raw) as unknown
  if (!isRecord(parsed) || parsed.schema_version !== 'e2cp.review_package.v1') return null
  if (parsed.package_status !== 'draft' && parsed.package_status !== 'submitted') {
    throw new Error('复核包 package_status 无效')
  }
  if (!isRecord(parsed.review) || parsed.review.schema_version !== 'e2cp.review_trace.v1') {
    throw new Error('复核包缺少有效的 review 记录')
  }
  const review = parsed.review as unknown as ReviewWorkspace
  if (!Array.isArray(review.rounds) || !Array.isArray(review.events) || !isRecord(review.segment_states)) {
    throw new Error('复核记录结构不完整')
  }
  for (const state of Object.values(review.segment_states)) {
    if (!isRecord(state) || !REVIEW_STATUSES.includes(state.status as ReviewSegmentStatus)) {
      throw new Error('复核记录包含未知片段状态')
    }
  }
  for (const event of review.events) {
    if (!isRecord(event) || !REVIEW_ACTIONS.includes(event.action as ReviewAction)) {
      throw new Error('复核记录包含未知操作类型')
    }
  }
  return parsed as unknown as ReviewPackage
}
