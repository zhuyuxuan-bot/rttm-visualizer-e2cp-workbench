export type SegmentReviewStatus = 'pending' | 'checked' | 'corrected' | 'uncertain' | 'deleted' | 'inserted'

export interface ReviewStatusSegment {
  speakerId: string
  text?: string
  reviewStatus?: SegmentReviewStatus
}

export interface ReviewStatusPatch {
  speakerId?: string
  reviewStatus?: SegmentReviewStatus
  text?: string
}

export function getReviewStatusAfterSegmentPatch(
  segment: ReviewStatusSegment,
  patch: ReviewStatusPatch,
): SegmentReviewStatus {
  const speakerChanged = patch.speakerId !== undefined && patch.speakerId !== segment.speakerId
  const textChanged = patch.text !== undefined && patch.text !== (segment.text ?? '')
  if (speakerChanged || textChanged) return 'corrected'
  return patch.reviewStatus ?? segment.reviewStatus ?? 'pending'
}
