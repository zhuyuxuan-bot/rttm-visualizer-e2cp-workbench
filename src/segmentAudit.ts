export type AuditableReviewStatus =
  | 'pending'
  | 'checked'
  | 'corrected'
  | 'uncertain'
  | 'deleted'
  | 'inserted'

export interface AuditableSegment {
  id?: string
  speakerId: string
  text?: string
  origin?: 'rttm' | 'manual_insert'
  reviewStatus?: AuditableReviewStatus
  notes?: string
  sourceSpeakerId?: string
  originalSpeakerId?: string
  originalText?: string
  evidence?: {
    audio?: { rttmSpeaker?: string }
    waveform?: { suspectedMissing?: boolean }
  }
}

export interface SegmentRevisionSummary {
  hasSpeakerChanged: boolean
  hasTextChanged: boolean
  badges: string[]
  speakerLine?: string
  textLine?: string
}

export function isManualInsertedSegment(segment: AuditableSegment): boolean {
  if (segment.origin === 'manual_insert' || segment.reviewStatus === 'inserted') return true
  if (segment.evidence?.waveform?.suspectedMissing && !segment.evidence.audio?.rttmSpeaker) return true
  return /manual inserted|inserted from waveform/i.test(segment.notes || '')
}

export function normalizeOriginalSpeakerFields<TSegment extends AuditableSegment>(
  segment: TSegment,
  importedSpeakerId?: string,
): TSegment {
  if (isManualInsertedSegment(segment)) {
    return {
      ...segment,
      origin: 'manual_insert',
      reviewStatus: segment.reviewStatus === 'deleted' ? 'deleted' : 'inserted',
      sourceSpeakerId: undefined,
      originalSpeakerId: undefined,
      originalText: undefined,
    }
  }
  const sourceSpeakerId = importedSpeakerId || segment.sourceSpeakerId
  if (!sourceSpeakerId) return segment
  if (segment.sourceSpeakerId === sourceSpeakerId && segment.originalSpeakerId === sourceSpeakerId) return segment
  return {
    ...segment,
    sourceSpeakerId,
    originalSpeakerId: sourceSpeakerId,
  }
}

function normalizeText(value?: string): string {
  return (value || '').trim()
}

export function preserveOriginalSegmentFields<TSegment extends AuditableSegment>(
  segment: TSegment,
  patch: Partial<AuditableSegment>,
  currentText?: string,
): Partial<AuditableSegment> {
  if (isManualInsertedSegment(segment)) {
    return {
      origin: 'manual_insert',
      sourceSpeakerId: undefined,
      originalSpeakerId: undefined,
      originalText: undefined,
    }
  }
  const next: Partial<AuditableSegment> = {}
  const speakerWillChange = patch.speakerId !== undefined && patch.speakerId !== segment.speakerId
  const textWillChange = patch.text !== undefined && normalizeText(patch.text) !== normalizeText(currentText ?? segment.text)

  if (speakerWillChange && !segment.originalSpeakerId) {
    next.originalSpeakerId = segment.sourceSpeakerId || segment.speakerId
  }

  if ((speakerWillChange || textWillChange) && segment.originalText === undefined) {
    next.originalText = currentText ?? segment.text ?? ''
  }

  return next
}

export function buildSegmentRevisionSummary(
  segment: AuditableSegment,
  labels: {
    originalSpeakerName?: string
    currentSpeakerName?: string
    currentText?: string
  } = {},
): SegmentRevisionSummary {
  if (isManualInsertedSegment(segment)) {
    return {
      hasSpeakerChanged: false,
      hasTextChanged: false,
      badges: [],
    }
  }
  const originalSpeaker = segment.sourceSpeakerId || segment.originalSpeakerId
  const currentSpeaker = segment.speakerId
  const originalText = segment.originalText
  const currentText = labels.currentText ?? segment.text ?? ''
  const hasSpeakerChanged = Boolean(originalSpeaker && originalSpeaker !== currentSpeaker)
  const hasTextChanged = originalText !== undefined && normalizeText(originalText) !== normalizeText(currentText)
  const badges: string[] = []

  if (hasSpeakerChanged) badges.push('说话人已改')
  if (hasTextChanged) badges.push('文本已改')

  return {
    hasSpeakerChanged,
    hasTextChanged,
    badges,
    speakerLine: hasSpeakerChanged
      ? `${labels.originalSpeakerName || originalSpeaker} -> ${labels.currentSpeakerName || currentSpeaker}`
      : undefined,
    textLine: hasTextChanged
      ? `${originalText} -> ${currentText}`
      : undefined,
  }
}
