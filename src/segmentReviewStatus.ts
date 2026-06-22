export type SegmentReviewStatus = 'pending' | 'checked' | 'corrected' | 'uncertain' | 'deleted' | 'inserted'

export interface ReviewStatusSegment {
  speakerId: string
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
  if (speakerChanged) return 'corrected'
  return patch.reviewStatus ?? segment.reviewStatus ?? 'pending'
}
