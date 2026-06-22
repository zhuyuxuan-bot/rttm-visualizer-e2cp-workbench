export interface PlaybackQueueSegment {
  id: string
  start: number
  end: number
}

export type PlaybackQueueStep =
  | { type: 'continue'; segmentId?: string }
  | { type: 'seek'; time: number; segmentId: string }
  | { type: 'pause' }

export function getFilteredPlaybackStep(
  queue: PlaybackQueueSegment[],
  currentTime: number,
  options: { wrapToFirst?: boolean; tolerance?: number } = {},
): PlaybackQueueStep {
  if (queue.length === 0) return { type: 'pause' }
  const tolerance = options.tolerance ?? 0.03
  const ordered = queue.slice().sort((a, b) => a.start - b.start)
  const active = ordered.find((segment) => (
    currentTime >= segment.start - tolerance && currentTime < segment.end - tolerance
  ))
  if (active) return { type: 'continue', segmentId: active.id }

  const next = ordered.find((segment) => segment.start > currentTime + tolerance)
  if (next) return { type: 'seek', time: next.start, segmentId: next.id }

  if (options.wrapToFirst) {
    const first = ordered[0]
    return { type: 'seek', time: first.start, segmentId: first.id }
  }
  return { type: 'pause' }
}
