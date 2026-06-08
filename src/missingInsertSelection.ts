export type MissingTimePickMode = 'idle' | 'start' | 'end' | 'range'

export type MissingInsertTimeDraft = {
  start: string
  end: string
}

export function formatDraftTime(seconds: number): string {
  return Math.max(0, seconds).toFixed(3)
}

function readDraftTime(value: string): number | null {
  if (value.trim() === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function normalizeDraftTimes(draft: MissingInsertTimeDraft): MissingInsertTimeDraft {
  const start = readDraftTime(draft.start)
  const end = readDraftTime(draft.end)
  if (start === null || end === null || end >= start) return draft

  return {
    start: formatDraftTime(end),
    end: formatDraftTime(start),
  }
}

export function applyMissingTimePoint(
  draft: MissingInsertTimeDraft,
  mode: Exclude<MissingTimePickMode, 'idle' | 'range'>,
  seconds: number,
): { draft: MissingInsertTimeDraft; message: string } {
  const field = mode === 'start' ? 'start' : 'end'
  const nextDraft = normalizeDraftTimes({
    ...draft,
    [field]: formatDraftTime(seconds),
  })

  return {
    draft: nextDraft,
    message: mode === 'start'
      ? `已填入漏句开始秒 ${formatDraftTime(seconds)}`
      : `已填入漏句结束秒 ${formatDraftTime(seconds)}`,
  }
}

export function applyMissingTimeRange(
  draft: MissingInsertTimeDraft,
  startSeconds: number,
  endSeconds: number,
): { draft: MissingInsertTimeDraft; message: string } {
  const start = Math.min(startSeconds, endSeconds)
  const end = Math.max(startSeconds, endSeconds)
  const nextDraft = {
    ...draft,
    start: formatDraftTime(start),
    end: formatDraftTime(end),
  }

  return {
    draft: nextDraft,
    message: `已框选漏句范围 ${formatDraftTime(start)} - ${formatDraftTime(end)}`,
  }
}
