export type DialogueFilterStatus = string | 'all'

export interface DialogueFilterSegment {
  speakerId: string
  reviewStatus?: string
}

export interface DialogueFilterRow<TSegment extends DialogueFilterSegment = DialogueFilterSegment> {
  segment: TSegment
  index: number
}

export function filterDialogueRows<TSegment extends DialogueFilterSegment>(
  rows: DialogueFilterRow<TSegment>[],
  filters: { status: DialogueFilterStatus; speakerId: string | 'all' },
): DialogueFilterRow<TSegment>[] {
  return rows.filter(({ segment }) => {
    const status = segment.reviewStatus || 'pending'
    const statusMatches = filters.status === 'all' || status === filters.status
    const speakerMatches = filters.speakerId === 'all' || segment.speakerId === filters.speakerId
    return statusMatches && speakerMatches
  })
}
