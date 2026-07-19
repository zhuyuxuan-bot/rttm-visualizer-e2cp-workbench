export type SegmentReviewStatus = 'pending' | 'checked' | 'corrected' | 'uncertain' | 'deleted' | 'inserted'

export interface ReviewStatusSegment {
  speakerId: string
  text?: string
  reviewStatus?: SegmentReviewStatus
  origin?: 'rttm' | 'manual_insert'
  notes?: string
  sourceSpeakerId?: string
  originalSpeakerId?: string
  evidence?: {
    audio?: { rttmSpeaker?: string }
    waveform?: { suspectedMissing?: boolean }
  }
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
  if (isManualInsertedSegment(segment)) {
    return patch.reviewStatus === 'deleted' ? 'deleted' : 'inserted'
  }
  if (speakerChanged || textChanged) return 'corrected'
  return patch.reviewStatus ?? segment.reviewStatus ?? 'pending'
}

function isManualInsertedSegment(segment: ReviewStatusSegment): boolean {
  if (segment.origin === 'manual_insert' || segment.reviewStatus === 'inserted') return true
  if (segment.evidence?.waveform?.suspectedMissing && !segment.evidence.audio?.rttmSpeaker) return true
  return /manual inserted|inserted from waveform/i.test(segment.notes || '')
}

export function getReviewStatusAfterPass(
  status: SegmentReviewStatus | undefined,
): SegmentReviewStatus {
  const currentStatus = status ?? 'pending'
  return currentStatus === 'pending' ? 'checked' : currentStatus
}
