export type ReviewStatus =
  | 'pending'
  | 'checked'
  | 'corrected'
  | 'inserted'
  | 'deleted'
  | 'uncertain'

export type SegmentType =
  | 'dialogue'
  | 'subtitle'
  | 'tail_caption'
  | 'ad'
  | 'unknown'

export type SegmentOrigin = 'rttm' | 'manual_insert'

export type ModalityAvailability = 'present' | 'missing' | 'not_applicable'

export interface SegmentEvidence {
  text?: {
    source: 'srt' | 'asr' | 'ocr' | 'manual' | 'unknown'
    value?: string
    confidence?: number
  }
  audio?: {
    rttmSpeaker?: string
    confidence?: number
  }
  visual?: {
    faceId?: string
    confidence?: number
    absentReason?: string
  }
  fusion?: {
    role?: string
    strategy?: string
    confidence?: number
  }
  waveform?: {
    suspectedMissing?: boolean
    peakScore?: number
  }
}

export interface ReviewSegment {
  id: string
  index: number
  start_ms: number
  end_ms: number
  speaker_id: string
  speaker_name: string
  text: string
  origin?: SegmentOrigin
  original?: {
    speaker_id?: string
    speaker_name?: string
    text?: string
  }
  segment_type: SegmentType
  review_status: ReviewStatus
  evidence: SegmentEvidence
  notes: string
}

export interface ReviewProject {
  schema_version: 'e2cp.review_project.v1'
  generated_at: string
  episode: {
    id: string
    title?: string
    duration_ms: number
  }
  media: {
    name?: string
    type?: 'audio' | 'video'
    duration_ms: number
  }
  source_files: {
    rttm?: string
    ref_rttm?: string
    srt?: string
    rttm_kind?: 'standard' | 'initial'
    subseg_match_results?: string
  }
  modality: {
    audio: ModalityAvailability
    text: ModalityAvailability
    visual: ModalityAvailability
  }
  speakers: Array<{
    id: string
    name: string
    color: string
    visible: boolean
    source?: 'rttm' | 'manual' | 'candidate'
  }>
  segments: ReviewSegment[]
  ref_segments: ReviewSegment[]
  suspected_missing_ranges: Array<{
    start_ms: number
    end_ms: number
    reason: 'waveform_activity_without_segment_or_subtitle'
  }>
}

export const secondsToMs = (seconds: number) => Math.round(seconds * 1000)

export function buildEpisodeProject(input: {
  media: { name?: string; type?: 'audio' | 'video'; duration?: number } | null
  rttm: { name?: string } | null
  refRTTM: { name?: string } | null
  srt: { name?: string } | null
  candidate?: { name?: string } | null
  rttmKind?: 'standard' | 'initial'
  speakers: Array<{ id: string; name: string; color: string; visible: boolean; source?: 'rttm' | 'manual' | 'candidate' }>
  segments: Array<{
    id: string
    speakerId: string
    start: number
    end: number
    text?: string
    origin?: SegmentOrigin
    originalSpeakerId?: string
    originalText?: string
    reviewStatus?: ReviewStatus
    notes?: string
    segmentType?: SegmentType
    evidence?: SegmentEvidence
  }>
  refSegments: Array<{ id: string; speakerId: string; start: number; end: number }>
  missingRanges: Array<{ start: number; end: number }>
}): ReviewProject {
  const durationSec = input.media?.duration ?? 0
  const speakerById = new Map(input.speakers.map((speaker) => [speaker.id, speaker]))

  const mapSegment = (
    segment: (typeof input.segments)[number],
    index: number,
  ): ReviewSegment => {
    const speaker = speakerById.get(segment.speakerId)
    const originalSpeaker = segment.originalSpeakerId ? speakerById.get(segment.originalSpeakerId) : undefined
    const text = segment.text ?? segment.evidence?.text?.value ?? ''
    const origin = segment.origin ?? (segment.reviewStatus === 'inserted' ? 'manual_insert' : 'rttm')
    return {
      id: segment.id,
      index: index + 1,
      start_ms: secondsToMs(segment.start),
      end_ms: secondsToMs(segment.end),
      speaker_id: segment.speakerId,
      speaker_name: speaker?.name ?? segment.speakerId,
      text,
      origin,
      original: origin !== 'manual_insert' && (segment.originalSpeakerId || segment.originalText !== undefined)
        ? {
            speaker_id: segment.originalSpeakerId,
            speaker_name: originalSpeaker?.name ?? segment.originalSpeakerId,
            text: segment.originalText,
          }
        : undefined,
      segment_type: segment.segmentType ?? 'dialogue',
      review_status: segment.reviewStatus ?? 'pending',
      evidence: {
        ...segment.evidence,
        text: segment.evidence?.text ?? (text ? { source: 'manual', value: text } : undefined),
      },
      notes: segment.notes ?? '',
    }
  }

  const refSegmentBySpeaker = (segment: (typeof input.refSegments)[number], index: number): ReviewSegment => ({
    id: segment.id,
    index: index + 1,
    start_ms: secondsToMs(segment.start),
    end_ms: secondsToMs(segment.end),
    speaker_id: segment.speakerId,
    speaker_name: segment.speakerId,
    text: '',
    origin: 'rttm',
    segment_type: 'dialogue',
    review_status: 'pending',
    evidence: { audio: { rttmSpeaker: segment.speakerId } },
    notes: 'Reference RTTM segment',
  })

  return {
    schema_version: 'e2cp.review_project.v1',
    generated_at: new Date().toISOString(),
    episode: {
      id: input.media?.name?.replace(/\.[^/.]+$/, '') || 'episode',
      duration_ms: secondsToMs(durationSec),
    },
    media: {
      name: input.media?.name,
      type: input.media?.type,
      duration_ms: secondsToMs(durationSec),
    },
    source_files: {
      rttm: input.rttm?.name,
      ref_rttm: input.refRTTM?.name,
      srt: input.srt?.name,
      rttm_kind: input.rttmKind,
      subseg_match_results: input.candidate?.name,
    },
    modality: {
      audio: input.rttm ? 'present' : 'missing',
      text: input.srt ? 'present' : 'missing',
      visual: input.candidate ? 'present' : 'missing',
    },
    speakers: input.speakers,
    segments: input.segments
      .slice()
      .sort((a, b) => a.start - b.start)
      .map(mapSegment),
    ref_segments: input.refSegments
      .slice()
      .sort((a, b) => a.start - b.start)
      .map(refSegmentBySpeaker),
    suspected_missing_ranges: input.missingRanges.map((range) => ({
      start_ms: secondsToMs(range.start),
      end_ms: secondsToMs(range.end),
      reason: 'waveform_activity_without_segment_or_subtitle',
    })),
  }
}
