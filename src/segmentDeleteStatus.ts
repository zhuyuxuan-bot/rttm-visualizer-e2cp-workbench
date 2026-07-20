import type { ReviewStatus } from './reviewSchema'

export type RestorableReviewStatus = Exclude<ReviewStatus, 'deleted'>

export interface DeleteStatusSegment {
  origin?: 'rttm' | 'manual_insert'
  reviewStatus?: ReviewStatus
  reviewStatusBeforeDelete?: RestorableReviewStatus
}

export function toggleDeletedReviewStatus<TSegment extends DeleteStatusSegment>(
  segment: TSegment,
): TSegment {
  const currentStatus = segment.reviewStatus ?? 'pending'

  if (currentStatus === 'deleted') {
    const restoredStatus = segment.reviewStatusBeforeDelete ?? (
      segment.origin === 'manual_insert' ? 'inserted' : 'pending'
    )
    return {
      ...segment,
      reviewStatus: restoredStatus,
      reviewStatusBeforeDelete: undefined,
    }
  }

  return {
    ...segment,
    reviewStatus: 'deleted',
    reviewStatusBeforeDelete: currentStatus,
  }
}
