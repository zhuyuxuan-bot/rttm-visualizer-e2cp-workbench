export interface AuditableSegment {
  id: string
  speakerId: string
  text?: string
  originalSpeakerId?: string
  originalText?: string
}

export interface SegmentRevisionSummary {
  hasSpeakerChanged: boolean
  hasTextChanged: boolean
  badges: string[]
  speakerLine?: string
  textLine?: string
}

function normalizeText(value?: string): string {
  return (value || '').trim()
}

export function preserveOriginalSegmentFields<TSegment extends AuditableSegment>(
  segment: TSegment,
  patch: Partial<AuditableSegment>,
  currentText?: string,
): Partial<AuditableSegment> {
  const next: Partial<AuditableSegment> = {}
  const speakerWillChange = patch.speakerId !== undefined && patch.speakerId !== segment.speakerId
  const textWillChange = patch.text !== undefined && normalizeText(patch.text) !== normalizeText(currentText ?? segment.text)

  if (speakerWillChange && !segment.originalSpeakerId) {
    next.originalSpeakerId = segment.speakerId
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
  const originalSpeaker = segment.originalSpeakerId
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
