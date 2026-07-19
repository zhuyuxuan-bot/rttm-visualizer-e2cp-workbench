import React, { Component, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Check, Download, Github, Pause, Pencil, Play, Plus, Search, SkipBack, SkipForward, Trash2, Upload, X, ZoomIn, ZoomOut } from 'lucide-react'
import { computeDER, type ErrorInterval, type DERMetrics } from './utils'
import { buildEpisodeProject, type ReviewStatus, type SegmentEvidence, type SegmentType } from './reviewSchema'
import {
  applyMissingTimePoint,
  applyMissingTimeRange,
  type MissingTimePickMode,
} from './missingInsertSelection'
import { sanitizeNonJsonNumericTokens } from './candidateJsonSanitizer'
import { filterDialogueRows } from './dialogueFilters'
import { getFilteredPlaybackSessionAfterSeek, getFilteredPlaybackStep } from './filteredPlaybackQueue'
import { stripSpeakerPrefix } from './dialogueText'
import { shouldSuppressGlobalShortcut } from './keyboardShortcuts'
import {
  buildSegmentRevisionSummary,
  normalizeOriginalSpeakerFields,
  preserveOriginalSegmentFields,
} from './segmentAudit'
import { getReviewStatusAfterPass, getReviewStatusAfterSegmentPatch } from './segmentReviewStatus'
import { getSpeakerPickerPosition, orderSpeakerPickerOptions, updateRecentSpeakerIds } from './speakerPicker'
import { ReviewWorkbench, type ReviewActionRequest, type ReviewDisplaySegment } from './ReviewWorkbench'
import {
  activateReviewRound,
  appendReviewEvent,
  buildReviewPackage,
  createReviewWorkspace,
  ensureReviewSegments,
  getLatestReviewEvent,
  parseReviewPackage,
  summarizeReviewWorkspace,
  type ReviewEvent,
  type ReviewWorkspace,
} from './reviewWorkflow'
import {
  episodeFileMatches,
  getEpisodeWorkPackage,
  summarizeBundledEpisodeAssets,
  type RttmKind,
} from './episodePackages'

type MediaType = 'audio' | 'video'

interface MediaFile {
  id: string
  name: string
  type: MediaType
  duration?: number
  url: string
  size?: number
}

interface RTTMFile {
  id: string
  name: string
  url: string
  matched: boolean
}

interface SRTFile {
  id: string
  name: string
  url: string
  subtitles: Subtitle[]
}

interface CandidateSpeaker {
  role?: string
  speaker?: string
  score?: number
  raw: unknown
}

interface CandidateFace {
  role?: string
  faceId?: string
  score?: number
  raw: unknown
}

interface CandidateEntry {
  id: string
  segmentKey: string
  start?: number
  end?: number
  subtitleText?: string
  top5Speakers: CandidateSpeaker[]
  top5Faces: CandidateFace[]
  raw: unknown
}

interface CandidateFile {
  id: string
  name: string
  url: string
  entries: CandidateEntry[]
}

interface Subtitle {
  id: number
  start: number
  end: number
  text: string
}

interface Segment {
  id: string
  speakerId: string
  start: number
  end: number
  text?: string
  origin?: 'rttm' | 'manual_insert'
  sourceSpeakerId?: string
  originalSpeakerId?: string
  originalText?: string
  reviewStatus?: ReviewStatus
  notes?: string
  segmentType?: SegmentType
  evidence?: SegmentEvidence
}

interface Speaker {
  id: string
  name: string
  color: string
  visible: boolean
  source?: 'rttm' | 'manual' | 'candidate'
}

function normalizeSpeakerSource(value?: string): Speaker['source'] | undefined {
  if (value === 'rttm' || value === 'manual' || value === 'candidate') return value
  return undefined
}

interface AnnotationSnapshot {
  segments: Segment[]
  speakers: Speaker[]
}

interface DraftPayload extends AnnotationSnapshot {
  schemaVersion: 'e2cp.rttm_workbench.draft.v1'
  savedAt: string
  selectedEpisodeId: string
  selectedSegId: string | null
  sourceFiles: {
    media?: string
    rttm?: string
    rttmKind?: RttmKind
    refRTTM?: string
    srt?: string
    candidate?: string
  }
  lastPlaybackTime?: number
  project?: ReturnType<typeof buildEpisodeProject>
}

interface ExportIssueSummary {
  total: number
  pending: number
  unknownSpeaker: number
  inserted: number
  deleted: number
  corrected: number
  checked: number
  uncertain: number
  emptyInserted: number
  invalidTime: number
  missingSpeaker: number
  suspectedMissingRanges: number
}

interface ExportIssues {
  blocking: string[]
  warnings: string[]
  summary: ExportIssueSummary
}

const DRAFT_SCHEMA_VERSION = 'e2cp.rttm_workbench.draft.v1' as const
const REVIEW_STATUS_VALUES: ReviewStatus[] = ['pending', 'checked', 'corrected', 'inserted', 'deleted', 'uncertain']
const SEGMENT_TYPE_VALUES: SegmentType[] = ['dialogue', 'subtitle', 'tail_caption', 'ad', 'unknown']
const LAST_EPISODE_STORAGE_KEY = 'e2cp-rttm-workbench-last-episode'
const MAX_HISTORY_STEPS = 80
const DIALOGUE_ROW_HEIGHT = 76
const DIALOGUE_OVERSCAN_ROWS = 12
type WorkMode = 'prepare' | 'annotate' | 'inspect'

function cloneSegments(segments: Segment[]): Segment[] {
  return segments.map((segment) => ({
    ...segment,
    evidence: segment.evidence
      ? JSON.parse(JSON.stringify(segment.evidence)) as SegmentEvidence
      : undefined,
  }))
}

function normalizeSegmentOriginalSpeaker(segment: Segment): Segment {
  return normalizeOriginalSpeakerFields(segment, segment.evidence?.audio?.rttmSpeaker)
}

function normalizeSegmentOriginalSpeakers(segments: Segment[]): Segment[] {
  return segments.map(normalizeSegmentOriginalSpeaker)
}

function cloneSpeakers(speakers: Speaker[]): Speaker[] {
  return speakers.map((speaker) => ({ ...speaker }))
}

function buildAnnotationSnapshot(segments: Segment[], speakers: Speaker[]): AnnotationSnapshot {
  return {
    segments: cloneSegments(segments),
    speakers: cloneSpeakers(speakers),
  }
}

function annotationSnapshotSignature(snapshot: AnnotationSnapshot): string {
  return JSON.stringify(snapshot)
}

function parseDraftPayload(raw: string | null): DraftPayload | null {
  if (!raw) return null
  const payload = JSON.parse(raw) as DraftPayload
  if (payload.schemaVersion !== DRAFT_SCHEMA_VERSION) return null
  return {
    ...payload,
    segments: normalizeSegmentOriginalSpeakers(payload.segments),
  }
}

function isReviewStatusValue(value: unknown): value is ReviewStatus {
  return typeof value === 'string' && REVIEW_STATUS_VALUES.includes(value as ReviewStatus)
}

function isSegmentTypeValue(value: unknown): value is SegmentType {
  return typeof value === 'string' && SEGMENT_TYPE_VALUES.includes(value as SegmentType)
}

function isRttmKindValue(value: unknown): value is RttmKind {
  return value === 'standard' || value === 'initial'
}

function parseReviewProjectSnapshot(raw: string): DraftPayload | null {
  const parsed = JSON.parse(raw)
  const root = asRecord(parsed)
  if (!root || root.schema_version !== 'e2cp.review_project.v1') return null

  const episode = asRecord(root.episode)
  const media = asRecord(root.media)
  const sourceFiles = asRecord(root.source_files)
  const rawSpeakers = Array.isArray(root.speakers) ? root.speakers : []
  const rawSegments = Array.isArray(root.segments) ? root.segments : []
  const palette = ['#3B82F6', '#EF4444', '#10B981', '#F59E0B', '#8B5CF6', '#06B6D4', '#84CC16', '#EC4899']

  const speakers = rawSpeakers.reduce<Speaker[]>((acc, speaker, index) => {
      const record = asRecord(speaker)
      if (!record) return acc
      const id = pickString(record, ['id', 'speaker_id', 'speakerId'])
      if (!id) return acc
      acc.push({
        id,
        name: pickString(record, ['name', 'speaker_name', 'speakerName']) || id,
        color: pickString(record, ['color']) || palette[index % palette.length],
        visible: record.visible !== false,
        source: normalizeSpeakerSource(pickString(record, ['source'])),
      })
      return acc
    }, [])

  const speakerIds = new Set(speakers.map((speaker) => speaker.id))
  const segments = rawSegments.reduce<Segment[]>((acc, segment, index) => {
      const record = asRecord(segment)
      if (!record) return acc
      const startMs = toNumber(record.start_ms)
      const endMs = toNumber(record.end_ms)
      const speakerId = pickString(record, ['speaker_id', 'speakerId', 'speaker']) || 'UNKNOWN'
      if (startMs === undefined || endMs === undefined) return acc
      const evidence = asRecord(record.evidence) as SegmentEvidence | null
      const original = asRecord(record.original)
      const notes = pickString(record, ['notes']) || ''
      const reviewStatus = isReviewStatusValue(record.review_status) ? record.review_status : 'pending'
      const origin = record.origin === 'manual_insert' ||
        reviewStatus === 'inserted' ||
        (evidence?.waveform?.suspectedMissing && !evidence?.audio?.rttmSpeaker) ||
        /manual inserted|inserted from waveform/i.test(notes)
          ? 'manual_insert'
          : 'rttm'
      const sourceSpeakerId = origin === 'manual_insert' ? undefined : evidence?.audio?.rttmSpeaker
      const importedOriginalSpeakerId =
        origin === 'manual_insert'
          ? undefined
          : pickString(original || {}, ['speaker_id', 'speakerId']) ||
            pickString(record, ['original_speaker_id', 'originalSpeakerId'])
      acc.push({
        id: pickString(record, ['id']) || `project_${index + 1}_${startMs}_${endMs}`,
        speakerId,
        start: startMs / 1000,
        end: Math.max(startMs / 1000 + 0.001, endMs / 1000),
        text: pickString(record, ['text']) || evidence?.text?.value || '',
        origin,
        sourceSpeakerId: sourceSpeakerId || importedOriginalSpeakerId,
        originalSpeakerId: sourceSpeakerId || importedOriginalSpeakerId,
        originalText:
          origin === 'manual_insert'
            ? undefined
            : pickOptionalString(original, ['text']) ??
              pickOptionalString(record, ['original_text', 'originalText']),
        reviewStatus: origin === 'manual_insert' && reviewStatus !== 'deleted' ? 'inserted' : reviewStatus,
        segmentType: isSegmentTypeValue(record.segment_type) ? record.segment_type : 'dialogue',
        evidence: evidence || undefined,
        notes,
      })
      return acc
    }, [])
    .sort((a, b) => a.start - b.start)

  for (const segment of segments) {
    if (!speakerIds.has(segment.speakerId)) {
      speakerIds.add(segment.speakerId)
      speakers.push({
        id: segment.speakerId,
        name: segment.speakerId,
        color: palette[speakers.length % palette.length],
        visible: true,
        source: 'manual',
      })
    }
  }

  const episodeId = normalizeEpisodeId(
    pickString(episode || {}, ['id', 'title']) ||
    pickString(media || {}, ['name']) ||
    pickString(sourceFiles || {}, ['rttm', 'srt']) ||
    '02',
  )

  return {
    schemaVersion: DRAFT_SCHEMA_VERSION,
    savedAt: new Date().toISOString(),
    selectedEpisodeId: episodeId,
    selectedSegId: segments[0]?.id ?? null,
    sourceFiles: {
      media: pickString(media || {}, ['name']),
      rttm: pickString(sourceFiles || {}, ['rttm']),
      rttmKind: isRttmKindValue(sourceFiles?.rttm_kind) ? sourceFiles.rttm_kind : undefined,
      refRTTM: pickString(sourceFiles || {}, ['ref_rttm']),
      srt: pickString(sourceFiles || {}, ['srt']),
      candidate: pickString(sourceFiles || {}, ['subseg_match_results']),
    },
    lastPlaybackTime: segments[0]?.start ?? 0,
    project: parsed as ReturnType<typeof buildEpisodeProject>,
    segments,
    speakers,
  }
}

function formatSavedAt(value: string | null): string {
  if (!value) return '等待标注变更'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function buildExportIssues(input: {
  segments: Segment[]
  speakers: Speaker[]
  media: MediaFile | null
  rttm: RTTMFile | null
  rttmKind: RttmKind
  srt: SRTFile | null
  candidateFile: CandidateFile | null
  selectedEpisodeId: string
  waveMissingRanges: Array<{ start: number; end: number }>
}): ExportIssues {
  const blocking: string[] = []
  const warnings: string[] = []
  const speakerIds = new Set(input.speakers.map((speaker) => speaker.id))

  if (input.segments.length === 0) blocking.push('没有可导出的说话片段')
  if (!input.media) warnings.push('未加载媒体文件，导出的工程 JSON 会缺少媒体来源')
  if (!input.rttm) warnings.push('未加载 RTTM 主文件，当前片段可能不是从标准说话人时间轴开始')
  if (!input.srt) warnings.push('未加载 SRT 字幕，文本校对缺少字幕上下文')
  if (!input.candidateFile) warnings.push('未加载 subseg_match_results.json，声纹/人脸候选证据不可见')
  if (input.rttmKind === 'initial') warnings.push('当前主 RTTM 类型是“初始标注 RTTM”，不要当作标准答案直接发布')

  const statusCount = (status: ReviewStatus) => input.segments.filter((segment) => (segment.reviewStatus || 'pending') === status).length
  const pendingCount = statusCount('pending')
  const insertedCount = statusCount('inserted')
  const deletedCount = statusCount('deleted')
  const correctedCount = statusCount('corrected')
  const checkedCount = statusCount('checked')
  const uncertainCount = statusCount('uncertain')
  const unknownSpeakerCount = input.segments.filter((segment) => {
    const speaker = input.speakers.find((item) => item.id === segment.speakerId)
    const label = `${segment.speakerId} ${speaker?.name || ''}`.toUpperCase()
    return label.includes('UNKNOWN') || label.includes('未知')
  }).length
  const emptyInsertedCount = input.segments.filter((segment) => (
    segment.reviewStatus === 'inserted' && !(segment.text || segment.evidence?.text?.value || '').trim()
  )).length
  const invalidTimeCount = input.segments.filter((segment) => (
    !Number.isFinite(segment.start) || !Number.isFinite(segment.end) || segment.end <= segment.start
  )).length
  const missingSpeakerCount = input.segments.filter((segment) => (
    input.speakers.length > 0 && !speakerIds.has(segment.speakerId)
  )).length

  if (invalidTimeCount > 0) blocking.push(`${invalidTimeCount} 条片段时间不合法`)
  if (missingSpeakerCount > 0) blocking.push(`${missingSpeakerCount} 条片段引用了不存在的说话人`)
  if (pendingCount > 0) warnings.push(`${pendingCount} 条片段仍是 pending`)
  if (unknownSpeakerCount > 0) warnings.push(`${unknownSpeakerCount} 条片段说话人仍是 UNKNOWN/未知`)
  if (deletedCount > 0) warnings.push(`${deletedCount} 条片段已标记删除，导出 RTTM 时会跳过`)
  if (emptyInsertedCount > 0) warnings.push(`${emptyInsertedCount} 条人工插入片段还没有填写文本`)
  if (input.waveMissingRanges.length > 0) warnings.push(`波峰仍提示 ${input.waveMissingRanges.length} 个疑似遗漏区间`)

  const selectedEpisode = episodeLabelFromId(input.selectedEpisodeId)
  const fileNames = [input.media?.name, input.rttm?.name, input.srt?.name, input.candidateFile?.name].filter(Boolean)
  if (fileNames.some((name) => !fileMatchesEpisode(name, input.selectedEpisodeId))) {
    warnings.push(`已选 ${selectedEpisode}，但部分源文件名不像这一集`)
  }

  return {
    blocking,
    warnings,
    summary: {
      total: input.segments.length,
      pending: pendingCount,
      unknownSpeaker: unknownSpeakerCount,
      inserted: insertedCount,
      deleted: deletedCount,
      corrected: correctedCount,
      checked: checkedCount,
      uncertain: uncertainCount,
      emptyInserted: emptyInsertedCount,
      invalidTime: invalidTimeCount,
      missingSpeaker: missingSpeakerCount,
      suspectedMissingRanges: input.waveMissingRanges.length,
    },
  }
}



function formatTime(sec:number){
  const m = Math.floor(sec/60)
  const s = Math.floor(sec%60).toString().padStart(2,'0')
  return `${m}:${s}`
}

function formatHMSms(seconds: number){
  const sign = seconds < 0 ? '-' : ''
  const t = Math.abs(seconds)
  const hours = Math.floor(t/3600)
  const minutes = Math.floor((t%3600)/60)
  const secs = t%60
  if(hours > 0) {
    return `${sign}${hours}:${minutes.toString().padStart(2,'0')}:${secs.toFixed(1).padStart(4,'0')}`
  } else {
    return `${sign}${minutes}:${secs.toFixed(1).padStart(4,'0')}`
  }
}

function findBestSubtitleForSegment(segment: Segment | null | undefined, subtitles: Subtitle[]): Subtitle | null {
  if (!segment || subtitles.length === 0) return null
  let best: { subtitle: Subtitle; score: number } | null = null
  const segmentMidpoint = (segment.start + segment.end) / 2

  for (const subtitle of subtitles) {
    if (subtitle.end < segment.start - 0.25) continue
    if (subtitle.start > segment.end + 0.25) break

    const overlap = Math.max(0, Math.min(segment.end, subtitle.end) - Math.max(segment.start, subtitle.start))
    const subtitleMidpointInside = segmentMidpoint >= subtitle.start && segmentMidpoint <= subtitle.end
    const score = overlap + (subtitleMidpointInside ? 0.05 : 0)

    if (score > 0.03 && (!best || score > best.score)) {
      best = { subtitle, score }
    }
  }

  return best?.subtitle ?? null
}

function parseSRT(text: string): Subtitle[] {
  const subtitles: Subtitle[] = []
  const blocks = text.trim().split(/\r?\n\r?\n/)
  
  for (const block of blocks) {
    const lines = block.split(/\r?\n/)
    if (lines.length < 3) continue
    
    const id = parseInt(lines[0])
    if (isNaN(id)) continue
    
    const timeMatch = lines[1].match(/(\d{2}):(\d{2}):(\d{2}),(\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2}),(\d{3})/)
    if (!timeMatch) continue
    
    const start = parseInt(timeMatch[1]) * 3600 + parseInt(timeMatch[2]) * 60 + parseInt(timeMatch[3]) + parseInt(timeMatch[4]) / 1000
    const end = parseInt(timeMatch[5]) * 3600 + parseInt(timeMatch[6]) * 60 + parseInt(timeMatch[7]) + parseInt(timeMatch[8]) / 1000
    
    const text = lines.slice(2).join('\n').trim()
    
    subtitles.push({ id, start, end, text })
  }
  
  return subtitles.sort((a, b) => a.start - b.start)
}

function parseRTTM(text:string): {segments:Segment[], speakers:Speaker[]} {
  const segs: Segment[] = []
  const speakerIndex = new Map<string, Speaker>()
  const colorPalette = [
    '#3B82F6','#EF4444','#10B981','#F59E0B','#8B5CF6','#06B6D4','#84CC16','#EC4899'
  ]
  let colorPtr = 0
  for(const raw of text.split(/\r?\n/)){
    const l = raw.trim()
    if(!l || l.startsWith(';')) continue
    const f = l.split(/\s+/)
    if(f[0] !== 'SPEAKER') continue
    const start = parseFloat(f[3])
    const dur = parseFloat(f[4])
    const spk = f[7] || 'spk'
    const end = start + dur
    const id = `${spk}_${start.toFixed(3)}_${end.toFixed(3)}`
    segs.push({
      id,
      speakerId: spk,
      sourceSpeakerId: spk,
      originalSpeakerId: spk,
      start,
      end,
      text: '',
      origin: 'rttm',
      reviewStatus: 'pending',
      segmentType: 'dialogue',
      evidence: {
        audio: { rttmSpeaker: spk },
        fusion: { role: spk, strategy: 'rttm' },
      },
    })
    if(!speakerIndex.has(spk)){
      const color = colorPalette[colorPtr % colorPalette.length]; colorPtr++
      speakerIndex.set(spk, { id: spk, name: spk, color, visible: true, source: 'rttm' })
    }
  }
  const speakers = Array.from(speakerIndex.values())
  segs.sort((a,b)=>a.start-b.start)
  return {segments: segs, speakers}
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

function pickString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

function pickOptionalString(record: Record<string, unknown> | null, keys: string[]): string | undefined {
  if (!record) return undefined
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string') return value
  }
  return undefined
}

function extractTimesFromKey(key: string): { start?: number; end?: number } {
  const keyMatch = key.match(/(?:^|_)(\d+(?:\.\d+)?)_(\d+(?:\.\d+)?)$/)
  if (keyMatch) {
    return { start: Number(keyMatch[1]), end: Number(keyMatch[2]) }
  }
  const rangeMatch = key.match(/(\d+(?:\.\d+)?)\s*[-~]\s*(\d+(?:\.\d+)?)/)
  if (rangeMatch) {
    return { start: Number(rangeMatch[1]), end: Number(rangeMatch[2]) }
  }
  return {}
}

function normalizeCandidateSpeaker(raw: unknown): CandidateSpeaker {
  const record = asRecord(raw)
  if (!record) return { raw }
  return {
    role: pickString(record, ['role', 'speaker', 'speaker_id', 'name', 'label']),
    speaker: pickString(record, ['speaker', 'speaker_id', 'id', 'name']),
    score: toNumber(record.score ?? record.sim ?? record.similarity ?? record.confidence),
    raw,
  }
}

function inferEpisodeLabel(names: Array<string | undefined>): string {
  const joined = names.filter(Boolean).join(' ')
  const epMatch = joined.match(/\b(?:ep|episode)[\s_-]*0?(\d{1,2})\b/i)
  if (epMatch) return `EP${epMatch[1].padStart(2, '0')}`
  const numericMatch = joined.match(/(?:^|[^\d])0?(\d{1,2})(?:[._\-\s]|$)/)
  return numericMatch ? `EP${numericMatch[1].padStart(2, '0')}` : '未识别'
}

function normalizeEpisodeId(value: string | number): string {
  const raw = String(value).trim()
  const match = raw.match(/\d{1,2}/)
  const n = match ? Math.max(1, Math.min(30, Number(match[0]))) : 1
  return n.toString().padStart(2, '0')
}

function episodeLabelFromId(value: string): string {
  return `EP${normalizeEpisodeId(value)}`
}

function getInitialEpisodeId(): string {
  if (typeof window === 'undefined') return '02'
  try {
    return normalizeEpisodeId(window.localStorage.getItem(LAST_EPISODE_STORAGE_KEY) || '02')
  } catch {
    return '02'
  }
}

function fileMatchesEpisode(name: string | undefined, episodeId: string): boolean {
  return episodeFileMatches(name, episodeId)
}

function normalizeCandidateFace(raw: unknown): CandidateFace {
  const record = asRecord(raw)
  if (!record) return { raw }
  return {
    role: pickString(record, ['role', 'name', 'label']),
    faceId: pickString(record, ['face_id', 'faceId', 'id']),
    score: toNumber(record.score ?? record.sim ?? record.similarity ?? record.confidence),
    raw,
  }
}

function getCandidateItems(parsed: unknown): Array<readonly [string, unknown]> {
  if (Array.isArray(parsed)) {
    return parsed.map((value, index) => [`item_${index + 1}`, value] as const)
  }

  const root = asRecord(parsed)
  if (!root) return []

  const wrappedKeys = ['results', 'segments', 'items', 'data', 'matches']
  for (const wrappedKey of wrappedKeys) {
    const wrappedValue = root[wrappedKey]
    if (Array.isArray(wrappedValue)) {
      return wrappedValue.map((value, index) => [`${wrappedKey}_${index + 1}`, value] as const)
    }
    const wrappedRecord = asRecord(wrappedValue)
    if (wrappedRecord) {
      return Object.entries(wrappedRecord)
    }
  }

  return Object.entries(root)
}

function extractTimesFromRangeValue(value: unknown): { start?: number; end?: number } {
  if (typeof value === 'string') return extractTimesFromKey(value)
  if (Array.isArray(value)) {
    return {
      start: toNumber(value[0]),
      end: toNumber(value[1]),
    }
  }
  const record = asRecord(value)
  if (!record) return {}
  return {
    start: toNumber(record.start ?? record.start_time ?? record.startTime),
    end: toNumber(record.end ?? record.end_time ?? record.endTime),
  }
}

function parseCandidateJSON(text: string): CandidateEntry[] {
  const parsed = JSON.parse(sanitizeNonJsonNumericTokens(text)) as unknown
  const items = getCandidateItems(parsed)

  return items.flatMap(([key, value], index) => {
    const record = asRecord(value)
    if (!record) return []
    const timeFromKey = extractTimesFromKey(key)
    const timeFromRange = extractTimesFromRangeValue(record.time_range ?? record.timeRange ?? record.range)
    const start = toNumber(record.start ?? record.start_time ?? record.startTime) ?? timeFromRange.start ?? timeFromKey.start
    const end = toNumber(record.end ?? record.end_time ?? record.endTime) ?? timeFromRange.end ?? timeFromKey.end
    const top5SpeakersRaw = record.top_5_speakers ?? record.top5_speakers ?? record.top5Speakers ?? record.speakers
    const top5FacesRaw = record.top_5_faces ?? record.top5_faces ?? record.top5Faces ?? record.faces
    return [{
      id: `${key}_${index}`,
      segmentKey: key,
      start,
      end,
      subtitleText: pickString(record, ['subtitle_text', 'subtitleText', 'text', 'sentence']),
      top5Speakers: Array.isArray(top5SpeakersRaw) ? top5SpeakersRaw.map(normalizeCandidateSpeaker) : [],
      top5Faces: Array.isArray(top5FacesRaw) ? top5FacesRaw.map(normalizeCandidateFace) : [],
      raw: value,
    }]
  })
}

const sampleVideo = "https://videos.pexels.com/video-files/30333849/13003128_2560_1440_25fps.mp4"

// Load local defaults from exp/ using Vite glob imports
// RTTM as raw text; media as URLs
const defaultRttmFiles = import.meta.glob('/exp/rttm/*.rttm', { eager: true, query: '?raw', import: 'default' }) as Record<string, string>
const defaultMediaFiles = import.meta.glob('/exp/raw/*.{mp4,webm,mp3,wav,m4a}', { eager: true, query: '?url', import: 'default' }) as Record<string, string>
const defaultSrtFiles = import.meta.glob('/exp/srt/*.srt', { eager: true, query: '?raw', import: 'default' }) as Record<string, string>
const defaultCandidateFiles = {
  ...import.meta.glob('/exp/json/**/*.json', { eager: true, query: '?raw', import: 'default' }),
  ...import.meta.glob('/exp/candidate/**/*.json', { eager: true, query: '?raw', import: 'default' }),
} as Record<string, string>
const WAVEFORM_HEIGHT = 148
const WAVEFORM_VERTICAL_PADDING = 18
const SUBTITLE_TRACK_HEIGHT = 48
const TIMELINE_RULER_HEIGHT = 24
const SPEAKER_TRACK_HEIGHT = 28
const MAX_VISIBLE_SPEAKER_TRACKS = 7
const WAVEFORM_POINTS_PER_SEC = 50
const WAVEFORM_MAX_CHUNK_WIDTH = 3000

interface AppErrorBoundaryState {
  error: Error | null
}

class AppErrorBoundary extends Component<{ children: ReactNode }, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): AppErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error) {
    console.error('RTTM visualizer runtime error:', error)
  }

  render() {
    if (this.state.error) {
      return (
        <div className="app-error-boundary notranslate" translate="no">
          <div className="app-error-card">
            <h1>RTTM 可视化器发生运行时错误</h1>
            <p>界面没有丢失数据。若反复出现 insertBefore，请先关闭浏览器翻译或会改写页面文字的插件，再点击按钮尝试恢复界面。</p>
            <pre>{this.state.error.message}</pre>
            <button className="btn tiny primary-action" onClick={() => this.setState({ error: null })}>
              尝试恢复界面
            </button>
          </div>
        </div>
      )
    }

    return this.props.children
  }
}

function AppContent(){
  const [title] = useState('RTTM Visualizer') // 1) Title updated
  const videoRef = useRef<HTMLVideoElement>(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [zoom, setZoom] = useState(1)

  useEffect(() => {
    document.documentElement.lang = 'zh-CN'
    document.documentElement.classList.add('notranslate')
    document.documentElement.setAttribute('translate', 'no')
    document.body.classList.add('notranslate')
    document.body.setAttribute('translate', 'no')
  }, [])
  const [media, setMedia] = useState<MediaFile|null>({ id:'sample', name:'sample.mp4', type:'video', url: sampleVideo })
  const [waveformSource, setWaveformSource] = useState<{url: string; name: string} | null>(null)
  const [rttm, setRTTM] = useState<RTTMFile|null>(null)
  const [refRTTM, setRefRTTM] = useState<RTTMFile|null>(null)
  const [srt, setSRT] = useState<SRTFile|null>(null)
  const [candidateFile, setCandidateFile] = useState<CandidateFile|null>(null)
  const [segments, setSegments] = useState<Segment[]>([])
  const [refSegments, setRefSegments] = useState<Segment[]>([])
  const [ghostSeg, setGhostSeg] = useState<{speakerId:string; start:number; end:number} | null>(null)
  const [speakers, setSpeakers] = useState<Speaker[]>([])
  const [derOverlay, setDerOverlay] = useState<ErrorInterval[]>([])
  const [metrics, setMetrics] = useState<DERMetrics | null>(null)
  const [showDER, setShowDER] = useState<boolean>(true)
  const [showRefTrack, setShowRefTrack] = useState<boolean>(true)
  const [leftCollapsed, setLeftCollapsed] = useState(false)
  const [rightCollapsed, setRightCollapsed] = useState(false)
  const [workMode, setWorkMode] = useState<WorkMode>('prepare')
  const [followPlayback, setFollowPlayback] = useState(true)
  const [missingInsertOpen, setMissingInsertOpen] = useState(false)
  const [selectedEpisodeId, setSelectedEpisodeId] = useState(getInitialEpisodeId)
  const [reviewerName, setReviewerName] = useState(() => {
    try { return window.localStorage.getItem('e2cp-reviewer-name') || '李明' } catch { return '李明' }
  })
  const [reviewRoundNumber, setReviewRoundNumber] = useState(1)
  const [reviewWorkspace, setReviewWorkspace] = useState<ReviewWorkspace | null>(null)
  const episodeManuallySelectedRef = useRef(false)
  const resourcePanelManuallyChangedRef = useRef(false)
  const hasAutoEnteredAnnotationRef = useRef(false)
  const centerRef = useRef<HTMLDivElement>(null)
  const [videoAreaHeight, setVideoAreaHeight] = useState<number>(400)
  const resizeStateRef = useRef<{startY:number; startH:number} | null>(null)
  const isScrubbingRef = useRef(false)
  const lastAutoLoadedEpisodeRef = useRef<string | null>(null)
  const bootDraftCheckedRef = useRef(false)
  const bootDraftRestoredRef = useRef(false)
  const [selectedSegId, setSelectedSegId] = useState<string|null>(null)
  const [segmentTextDraft, setSegmentTextDraft] = useState('')
  const [inlineTextEdit, setInlineTextEdit] = useState<{ segmentId: string; value: string } | null>(null)
  const [inlineSpeakerPicker, setInlineSpeakerPicker] = useState<{
    segmentId: string
    mode: 'assign' | 'add'
    query: string
    x: number
    y: number
  } | null>(null)
  const [recentSpeakerIds, setRecentSpeakerIds] = useState<string[]>([])
  const [segmentNotesDraft, setSegmentNotesDraft] = useState('')
  const [segmentStatusFilter, setSegmentStatusFilter] = useState<ReviewStatus | 'all'>('all')
  const [segmentSpeakerFilter, setSegmentSpeakerFilter] = useState<string | 'all'>('all')
  const filteredPlaybackSessionRef = useRef(false)
  const [packageNotice, setPackageNotice] = useState('')
  const [missingInsertDraft, setMissingInsertDraft] = useState({ start: '', end: '', text: '', speakerId: '' })
  const [missingPickMode, setMissingPickMode] = useState<MissingTimePickMode>('idle')
  const [missingRangePreview, setMissingRangePreview] = useState<{ start: number; end: number } | null>(null)
  const missingRangeAnchorRef = useRef<number | null>(null)
  const [timeProbe, setTimeProbe] = useState<{ time: number; clientX: number; speakerName?: string } | null>(null)
  const lastTimeProbeRef = useRef<{ time: number; speakerName?: string } | null>(null)
  const segmentTextCommitTimerRef = useRef<number | null>(null)
  const segmentNotesCommitTimerRef = useRef<number | null>(null)
  const pendingSegmentTextCommitRef = useRef<{ segmentId: string; value: string } | null>(null)
  const pendingSegmentNotesCommitRef = useRef<{ segmentId: string; value: string } | null>(null)
  const timeProbeFrameRef = useRef<number | null>(null)
  const pendingTimeProbeRef = useRef<{ time: number; clientX: number; speakerName?: string } | null>(null)
  const missingRangePreviewFrameRef = useRef<number | null>(null)
  const pendingMissingRangePreviewRef = useRef<{ start: number; end: number } | null>(null)
  const waveMissingRangesRef = useRef<Array<{ start: number; end: number }>>([])
  const ghostSegFrameRef = useRef<number | null>(null)
  const pendingGhostSegRef = useRef<{speakerId:string; start:number; end:number} | null>(null)
  const lastGhostSegRef = useRef<{speakerId:string; start:number; end:number} | null>(null)
  const suppressTimelineClickRef = useRef(false)
  const timelineScrollbarDragRef = useRef(false)
  const dragRef = useRef<{ type: 'start'|'end'|'move'|'create'; speakerId: string; segId?: string; anchorTime?: number } | null>(null)
  const [dragTip, setDragTip] = useState<{x:number;y:number;text:string}|null>(null)
  const segmentsRef = useRef<Segment[]>([])
  const speakersRef = useRef<Speaker[]>([])
  const trackRefs = useRef<Map<string, HTMLDivElement>>(new Map())
  const speakerTracksViewportRef = useRef<HTMLDivElement>(null)
  const dialogueListRef = useRef<HTMLDivElement>(null)
  const inlineSpeakerPickerRef = useRef<HTMLDivElement>(null)
  const [dialogueScrollTop, setDialogueScrollTop] = useState(0)
  const [dialogueViewportHeight, setDialogueViewportHeight] = useState(480)
  const autoDialogueScrollingRef = useRef(false)
  const releaseAutoDialogueScrollRef = useRef<number | null>(null)
  useEffect(()=>{ segmentsRef.current = segments }, [segments])
  useEffect(()=>{ speakersRef.current = speakers }, [speakers])
  const selectedSegment = useMemo(
    () => segments.find((segment) => segment.id === selectedSegId) ?? null,
    [segments, selectedSegId],
  )
  const selectedSpeaker = useMemo(
    () => speakers.find((speaker) => speaker.id === selectedSegment?.speakerId) ?? null,
    [speakers, selectedSegment?.speakerId],
  )
  const inlineSpeakerPickerSegment = useMemo(
    () => segments.find((segment) => segment.id === inlineSpeakerPicker?.segmentId) ?? null,
    [inlineSpeakerPicker?.segmentId, segments],
  )
  const inlineSpeakerPickerOptions = useMemo(
    () => orderSpeakerPickerOptions(speakers, recentSpeakerIds, inlineSpeakerPicker?.query || ''),
    [inlineSpeakerPicker?.query, recentSpeakerIds, speakers],
  )
  const episodePackage = useMemo(
    () => getEpisodeWorkPackage(selectedEpisodeId),
    [selectedEpisodeId],
  )
  const rttmKind = episodePackage.rttmKind
  const rttmKindLabel = episodePackage.rttmLabel
  const isInitialRttmPackage = rttmKind === 'initial'
  const speakerTextLabels = useMemo(
    () => Array.from(new Set(speakers.flatMap((speaker) => [speaker.name, speaker.id]).filter(Boolean))),
    [speakers],
  )
  const allSubtitles = useMemo(() => {
    return srt?.subtitles ?? []
  }, [srt])
  const getSegmentDisplayText = useCallback((segment: Segment): string => {
    const subtitle = segment.text?.trim() ? null : findBestSubtitleForSegment(segment, allSubtitles)
    const rawText = segment.text?.trim() || subtitle?.text || ''
    return stripSpeakerPrefix(rawText, speakerTextLabels)
  }, [allSubtitles, speakerTextLabels])
  const reviewDisplaySegments = useMemo<ReviewDisplaySegment[]>(() => {
    const speakerById = new Map(speakers.map((speaker) => [speaker.id, speaker]))
    return segments
      .slice()
      .sort((left, right) => left.start - right.start)
      .map((segment, index) => {
        const speaker = speakerById.get(segment.speakerId)
        return {
          id: segment.id,
          index: index + 1,
          start: segment.start,
          end: segment.end,
          speakerId: segment.speakerId,
          speakerName: speaker?.name || segment.speakerId,
          speakerColor: speaker?.color || '#64748b',
          text: getSegmentDisplayText(segment),
        }
      })
  }, [getSegmentDisplayText, segments, speakers])
  const segmentsBySpeaker = useMemo(() => {
    const map = new Map<string, Segment[]>()
    for (const segment of segments) {
      const list = map.get(segment.speakerId)
      if (list) list.push(segment)
      else map.set(segment.speakerId, [segment])
    }
    return map
  }, [segments])
  const speakerUsageCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const segment of segments) {
      counts.set(segment.speakerId, (counts.get(segment.speakerId) || 0) + 1)
    }
    return counts
  }, [segments])
  useEffect(() => {
    if (!inlineSpeakerPicker) return
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (inlineSpeakerPickerRef.current?.contains(event.target as Node)) return
      setInlineSpeakerPicker(null)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setInlineSpeakerPicker(null)
    }
    document.addEventListener('pointerdown', closeOnOutsidePointer)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [inlineSpeakerPicker?.segmentId])
  useEffect(() => {
    if (segmentSpeakerFilter !== 'all' && !speakers.some((speaker) => speaker.id === segmentSpeakerFilter)) {
      setSegmentSpeakerFilter('all')
    }
  }, [segmentSpeakerFilter, speakers])
  useEffect(() => {
    if (!selectedSegment?.speakerId) return
    const viewport = speakerTracksViewportRef.current
    const track = trackRefs.current.get(selectedSegment.speakerId)
    if (!viewport || !track) return

    const frame = window.requestAnimationFrame(() => {
      const viewportRect = viewport.getBoundingClientRect()
      const trackRect = track.getBoundingClientRect()

      if (trackRect.top < viewportRect.top) {
        viewport.scrollTop -= viewportRect.top - trackRect.top
      } else if (trackRect.bottom > viewportRect.bottom) {
        viewport.scrollTop += trackRect.bottom - viewportRect.bottom
      }
    })

    return () => window.cancelAnimationFrame(frame)
  }, [selectedSegment?.speakerId, speakers.length])
  const selectedCandidate = useMemo(() => {
    if (!selectedSegment || !candidateFile?.entries.length) return null
    let best: { entry: CandidateEntry; overlap: number } | null = null
    for (const entry of candidateFile.entries) {
      if (entry.start === undefined || entry.end === undefined) continue
      const overlap = Math.min(selectedSegment.end, entry.end) - Math.max(selectedSegment.start, entry.start)
      const midpoint = (selectedSegment.start + selectedSegment.end) / 2
      const midpointInside = midpoint >= entry.start && midpoint <= entry.end
      const score = Math.max(0, overlap) + (midpointInside ? 0.01 : 0)
      if (score > 0 && (!best || score > best.overlap)) best = { entry, overlap: score }
    }
    return best?.entry ?? null
  }, [candidateFile, selectedSegment])
  const selectedRevisionSummary = useMemo(() => {
    if (!selectedSegment) return null
    const originalSpeaker = selectedSegment.originalSpeakerId
      ? speakers.find((speaker) => speaker.id === selectedSegment.originalSpeakerId)
      : null
    return buildSegmentRevisionSummary(selectedSegment, {
      originalSpeakerName: originalSpeaker?.name || selectedSegment.originalSpeakerId,
      currentSpeakerName: selectedSpeaker?.name || selectedSegment.speakerId,
      currentText: getSegmentDisplayText(selectedSegment),
    })
  }, [getSegmentDisplayText, selectedSegment, selectedSpeaker?.name, speakers])
  const selectedReviewEvent = useMemo(() => (
    selectedSegment && reviewWorkspace
      ? getLatestReviewEvent(reviewWorkspace, selectedSegment.id)
      : null
  ), [reviewWorkspace, selectedSegment])
  const updateSelectedSegment = useCallback((patch: Partial<Segment>) => {
    if (!selectedSegId) return
    setSegments((prev) => prev.map((segment) => (
      segment.id === selectedSegId
        ? {
            ...segment,
            ...preserveOriginalSegmentFields(segment, patch, getSegmentDisplayText(segment)),
            ...patch,
            reviewStatus: getReviewStatusAfterSegmentPatch(segment, patch),
            evidence: patch.evidence
              ? { ...segment.evidence, ...patch.evidence }
              : segment.evidence,
          }
        : segment
    )))
  }, [getSegmentDisplayText, selectedSegId])
  const commitSegmentTextToSegment = useCallback((segmentId: string, value: string) => {
    const nextValue = value.trim()
    setSegments((prev) => prev.map((segment) => (
      segment.id === segmentId
        ? (() => {
            const currentText = getSegmentDisplayText(segment).trim()
            if (nextValue === currentText) return segment
            return {
              ...segment,
              ...preserveOriginalSegmentFields(segment, { text: nextValue }, currentText),
              text: nextValue,
              evidence: {
                ...segment.evidence,
                text: { source: 'manual' as const, value: nextValue },
              },
              reviewStatus: getReviewStatusAfterSegmentPatch(
                { ...segment, text: currentText },
                { text: nextValue },
              ),
            }
          })()
        : segment
    )))
  }, [getSegmentDisplayText])
  const commitInlineTextEdit = useCallback((segmentId: string, value: string) => {
    commitSegmentTextToSegment(segmentId, value)
    setInlineTextEdit((current) => current?.segmentId === segmentId ? null : current)
  }, [commitSegmentTextToSegment])
  const commitSegmentNotesToSegment = useCallback((segmentId: string, value: string) => {
    setSegments((prev) => prev.map((segment) => (
      segment.id === segmentId
        ? { ...segment, notes: value }
        : segment
    )))
  }, [])
  const scheduleSegmentTextCommit = useCallback((value: string) => {
    setSegmentTextDraft(value)
    if (!selectedSegId) return
    const pending = pendingSegmentTextCommitRef.current
    if (segmentTextCommitTimerRef.current !== null) {
      window.clearTimeout(segmentTextCommitTimerRef.current)
      segmentTextCommitTimerRef.current = null
    }
    if (pending && pending.segmentId !== selectedSegId) {
      commitSegmentTextToSegment(pending.segmentId, pending.value)
    }
    pendingSegmentTextCommitRef.current = { segmentId: selectedSegId, value }
    segmentTextCommitTimerRef.current = window.setTimeout(() => {
      const latest = pendingSegmentTextCommitRef.current
      pendingSegmentTextCommitRef.current = null
      segmentTextCommitTimerRef.current = null
      if (latest) commitSegmentTextToSegment(latest.segmentId, latest.value)
    }, 450)
  }, [commitSegmentTextToSegment, selectedSegId])
  const scheduleSegmentNotesCommit = useCallback((value: string) => {
    setSegmentNotesDraft(value)
    if (!selectedSegId) return
    const pending = pendingSegmentNotesCommitRef.current
    if (segmentNotesCommitTimerRef.current !== null) {
      window.clearTimeout(segmentNotesCommitTimerRef.current)
      segmentNotesCommitTimerRef.current = null
    }
    if (pending && pending.segmentId !== selectedSegId) {
      commitSegmentNotesToSegment(pending.segmentId, pending.value)
    }
    pendingSegmentNotesCommitRef.current = { segmentId: selectedSegId, value }
    segmentNotesCommitTimerRef.current = window.setTimeout(() => {
      const latest = pendingSegmentNotesCommitRef.current
      pendingSegmentNotesCommitRef.current = null
      segmentNotesCommitTimerRef.current = null
      if (latest) commitSegmentNotesToSegment(latest.segmentId, latest.value)
    }, 450)
  }, [commitSegmentNotesToSegment, selectedSegId])
  const flushPendingSegmentText = useCallback(() => {
    if (segmentTextCommitTimerRef.current !== null) {
      window.clearTimeout(segmentTextCommitTimerRef.current)
      segmentTextCommitTimerRef.current = null
    }
    const pending = pendingSegmentTextCommitRef.current
    pendingSegmentTextCommitRef.current = null
    if (pending) commitSegmentTextToSegment(pending.segmentId, pending.value)
  }, [commitSegmentTextToSegment])
  const flushPendingSegmentNotes = useCallback(() => {
    if (segmentNotesCommitTimerRef.current !== null) {
      window.clearTimeout(segmentNotesCommitTimerRef.current)
      segmentNotesCommitTimerRef.current = null
    }
    const pending = pendingSegmentNotesCommitRef.current
    pendingSegmentNotesCommitRef.current = null
    if (pending) commitSegmentNotesToSegment(pending.segmentId, pending.value)
  }, [commitSegmentNotesToSegment])
  useEffect(() => {
    setSegmentTextDraft(selectedSegment ? getSegmentDisplayText(selectedSegment) : '')
    setSegmentNotesDraft(selectedSegment?.notes || '')
  }, [getSegmentDisplayText, selectedSegment?.id, selectedSegment?.notes, selectedSegment?.text])
  const addSpeaker = useCallback((name?: string, source: Speaker['source'] = 'manual') => {
    const trimmed = (name || '').trim()
    const baseName = trimmed || `speaker${speakers.length + 1}`
    const safeId = baseName
      .replace(/\s+/g, '_')
      .replace(/[^\w\u4e00-\u9fa5-]/g, '')
      || `speaker${speakers.length + 1}`
    let id = safeId
    let suffix = 2
    while (speakers.some((speaker) => speaker.id === id)) {
      id = `${safeId}_${suffix++}`
    }
    const palette = ['#3B82F6','#EF4444','#10B981','#F59E0B','#8B5CF6','#06B6D4','#84CC16','#EC4899','#14B8A6','#F472B6']
    const color = palette[speakers.length % palette.length]
    const speaker: Speaker = { id, name: baseName, color, visible: true, source }
    setSpeakers((prev) => [...prev, speaker])
    return speaker
  }, [speakers])
  const respondToReviewSuggestion = useCallback((acceptProposal: boolean) => {
    if (!selectedSegId || !selectedReviewEvent || !reviewWorkspace) return
    const currentSegment = segmentsRef.current.find((segment) => segment.id === selectedSegId)
    if (!currentSegment) return
    const proposal = selectedReviewEvent.proposed_after
    const currentSpeaker = speakersRef.current.find((speaker) => speaker.id === currentSegment.speakerId)
    const before = {
      speaker_id: currentSegment.speakerId,
      speaker_name: currentSpeaker?.name || currentSegment.speakerId,
      text: getSegmentDisplayText(currentSegment),
      start_ms: Math.round(currentSegment.start * 1000),
      end_ms: Math.round(currentSegment.end * 1000),
    }
    const applied = acceptProposal && proposal ? proposal : before

    if (acceptProposal && proposal) {
      if (!speakersRef.current.some((speaker) => speaker.id === proposal.speaker_id)) {
        const palette = ['#3B82F6','#EF4444','#10B981','#F59E0B','#8B5CF6','#06B6D4','#84CC16','#EC4899']
        setSpeakers((current) => [
          ...current,
          {
            id: proposal.speaker_id,
            name: proposal.speaker_name || proposal.speaker_id,
            color: palette[current.length % palette.length],
            visible: true,
            source: 'manual',
          },
        ])
      }
      setSegments((current) => current.map((segment) => {
        if (segment.id !== selectedSegId) return segment
        const patch: Partial<Segment> = {
          speakerId: proposal.speaker_id,
          text: proposal.text,
          start: proposal.start_ms / 1000,
          end: proposal.end_ms / 1000,
          reviewStatus: getReviewStatusAfterSegmentPatch(currentSegment, {
            speakerId: proposal.speaker_id,
            text: proposal.text,
          }),
        }
        return {
          ...segment,
          ...preserveOriginalSegmentFields(segment, patch, getSegmentDisplayText(segment)),
          ...patch,
          evidence: {
            ...segment.evidence,
            text: { source: 'manual', value: proposal.text },
            fusion: { role: proposal.speaker_name, strategy: 'accepted_review_proposal' },
          },
        }
      }))
      setSegmentTextDraft(proposal.text)
    }

    const now = new Date().toISOString()
    setReviewWorkspace((current) => {
      if (!current || current.episode_id !== selectedEpisodeId) return current
      return appendReviewEvent(current, {
        id: crypto.randomUUID(),
        round_id: selectedReviewEvent.round_id,
        segment_id: selectedSegId,
        actor: { id: 'annotator-local', name: '标注人', role: 'annotator' },
        action: 'annotator_replied',
        issue_types: selectedReviewEvent.issue_types,
        before,
        proposed_after: applied,
        reason: acceptProposal && proposal ? '已接受检查建议并完成回改' : '已复查，保留当前标注值',
        evidence_time_ms: Math.round(currentTime * 1000),
        created_at: now,
      })
    })
    setToast({ message: acceptProposal && proposal ? '已接受检查建议、完成回改并留下回复痕迹' : '已保留当前值并回复检查人' })
    window.setTimeout(() => setToast(null), 3600)
  }, [currentTime, getSegmentDisplayText, reviewWorkspace, selectedEpisodeId, selectedReviewEvent, selectedSegId])
  const [ctxMenu, setCtxMenu] = useState<{x:number; y:number; segId: string} | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<{open: boolean; segId: string} | null>(null)
  const lastDeletedRef = useRef<Segment | null>(null)
  const [toast, setToast] = useState<{message: string; actionLabel?: string; onAction?: ()=>void} | null>(null)
  const removeManualSpeaker = useCallback((speaker: Speaker) => {
    const usedCount = speakerUsageCounts.get(speaker.id) || 0
    if (speaker.source !== 'manual') {
      setToast({ message: '只能删除人工新增的说话人，RTTM 原始说话人请保留。' })
      window.setTimeout(() => setToast(null), 3600)
      return
    }
    if (usedCount > 0) {
      setToast({ message: `无法删除「${speaker.name}」：已有 ${usedCount} 个片段使用它，请先把这些片段改成其他说话人。` })
      window.setTimeout(() => setToast(null), 5200)
      return
    }
    setSpeakers((prev) => prev.filter((item) => item.id !== speaker.id))
    setToast({ message: `已删除人工新增说话人「${speaker.name}」。` })
    window.setTimeout(() => setToast(null), 3200)
  }, [speakerUsageCounts])
  const historyRef = useRef<AnnotationSnapshot[]>([])
  const historyCursorRef = useRef(-1)
  const historySkipRef = useRef(false)
  const lastHistorySignatureRef = useRef('')
  const [historyCursor, setHistoryCursor] = useState(-1)
  const [historyLength, setHistoryLength] = useState(0)
  const [lastDraftSavedAt, setLastDraftSavedAt] = useState<string | null>(null)
  const [draftAvailable, setDraftAvailable] = useState(false)
  const [exportIssues, setExportIssues] = useState<ExportIssues | null>(null)
  const draftStorageKey = useMemo(() => `e2cp-rttm-workbench-draft-${selectedEpisodeId}`, [selectedEpisodeId])
  const reviewStorageKey = useMemo(() => `e2cp-rttm-workbench-review-${selectedEpisodeId}`, [selectedEpisodeId])
  const canUndo = historyCursor > 0
  const canRedo = historyLength > 0 && historyCursor >= 0 && historyCursor < historyLength - 1
  const [playbackRate, setPlaybackRate] = useState<number>(1.0); // 默认 1x

  useEffect(() => {
    try {
      window.localStorage.setItem(LAST_EPISODE_STORAGE_KEY, selectedEpisodeId)
    } catch {
      // Local storage is only a convenience for resuming work.
    }
  }, [selectedEpisodeId])

  useEffect(() => {
    try { window.localStorage.setItem('e2cp-reviewer-name', reviewerName) } catch { /* Optional convenience only. */ }
  }, [reviewerName])

  useEffect(() => {
    if (workMode !== 'inspect' || segments.length === 0) return
    setReviewWorkspace((current) => {
      if (current?.episode_id === selectedEpisodeId) {
        return activateReviewRound(
          ensureReviewSegments(current, segments.map((segment) => segment.id)),
          { roundNumber: reviewRoundNumber, reviewerName },
        )
      }
      try {
        const raw = window.localStorage.getItem(reviewStorageKey)
        if (raw) {
          const restored = JSON.parse(raw) as ReviewWorkspace
          if (restored.schema_version === 'e2cp.review_trace.v1' && restored.episode_id === selectedEpisodeId) {
            setReviewRoundNumber(restored.rounds.find((round) => round.id === restored.active_round_id)?.number || 1)
            return activateReviewRound(
              ensureReviewSegments(restored, segments.map((segment) => segment.id)),
              { roundNumber: reviewRoundNumber, reviewerName },
            )
          }
        }
      } catch {
        // A damaged browser draft must not block a new review round.
      }
      return createReviewWorkspace({
        episodeId: selectedEpisodeId,
        segmentIds: segments.map((segment) => segment.id),
        reviewerName,
        roundNumber: reviewRoundNumber,
      })
    })
  }, [reviewRoundNumber, reviewStorageKey, reviewerName, segments, selectedEpisodeId, workMode])

  useEffect(() => {
    if (!reviewWorkspace || reviewWorkspace.episode_id !== selectedEpisodeId) return
    try { window.localStorage.setItem(reviewStorageKey, JSON.stringify(reviewWorkspace)) } catch { /* Export remains available. */ }
  }, [reviewStorageKey, reviewWorkspace, selectedEpisodeId])

  useEffect(()=>{
    const closeMenu = () => setCtxMenu(null)
    const onKey = (e: KeyboardEvent) => { if(e.key==='Escape'){ setCtxMenu(null); setConfirmDelete(null) } }
    window.addEventListener('click', closeMenu)
    window.addEventListener('scroll', closeMenu, true)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('click', closeMenu)
      window.removeEventListener('scroll', closeMenu, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [])

  const restoreAnnotationSnapshot = useCallback((snapshot: AnnotationSnapshot) => {
    const restored = buildAnnotationSnapshot(normalizeSegmentOriginalSpeakers(snapshot.segments), snapshot.speakers)
    const signature = annotationSnapshotSignature(restored)
    historySkipRef.current = true
    lastHistorySignatureRef.current = signature
    setSegments(restored.segments)
    setSpeakers(restored.speakers)
    setSelectedSegId((current) => (
      current && restored.segments.some((segment) => segment.id === current)
        ? current
        : restored.segments[0]?.id ?? null
    ))
  }, [])

  const undoAnnotation = useCallback(() => {
    const current = historyCursorRef.current
    if (current <= 0) return
    const next = current - 1
    historyCursorRef.current = next
    setHistoryCursor(next)
    restoreAnnotationSnapshot(historyRef.current[next])
  }, [restoreAnnotationSnapshot])

  const redoAnnotation = useCallback(() => {
    const current = historyCursorRef.current
    const next = current + 1
    if (next < 0 || next >= historyRef.current.length) return
    historyCursorRef.current = next
    setHistoryCursor(next)
    restoreAnnotationSnapshot(historyRef.current[next])
  }, [restoreAnnotationSnapshot])

  useEffect(() => {
    const snapshot = buildAnnotationSnapshot(segments, speakers)
    if (snapshot.segments.length === 0 && snapshot.speakers.length === 0 && historyRef.current.length === 0) return
    const signature = annotationSnapshotSignature(snapshot)
    if (historySkipRef.current) {
      historySkipRef.current = false
      lastHistorySignatureRef.current = signature
      return
    }
    if (signature === lastHistorySignatureRef.current) return

    const base = historyRef.current.slice(0, historyCursorRef.current + 1)
    base.push(snapshot)
    const nextHistory = base.length > MAX_HISTORY_STEPS ? base.slice(base.length - MAX_HISTORY_STEPS) : base
    historyRef.current = nextHistory
    historyCursorRef.current = nextHistory.length - 1
    lastHistorySignatureRef.current = signature
    setHistoryCursor(historyCursorRef.current)
    setHistoryLength(nextHistory.length)
  }, [segments, speakers])

  useEffect(() => {
    try {
      const payload = parseDraftPayload(window.localStorage.getItem(draftStorageKey))
      setDraftAvailable(Boolean(payload))
      if (payload) {
        setLastDraftSavedAt(payload.savedAt)
      } else {
        setLastDraftSavedAt(null)
      }
    } catch {
      setDraftAvailable(false)
      setLastDraftSavedAt(null)
    }
  }, [draftStorageKey])

  useEffect(() => {
    if (!bootDraftCheckedRef.current) return
    if (segments.length === 0 && speakers.length === 0) return
    const timer = window.setTimeout(() => {
      const savedAt = new Date().toISOString()
      const payload: DraftPayload = {
        schemaVersion: DRAFT_SCHEMA_VERSION,
        savedAt,
        selectedEpisodeId,
        selectedSegId,
        sourceFiles: {
          media: media?.name,
          rttm: rttm?.name,
          rttmKind,
          refRTTM: refRTTM?.name,
          srt: srt?.name,
          candidate: candidateFile?.name,
        },
        lastPlaybackTime: videoRef.current?.currentTime ?? currentTime,
        project: buildEpisodeProject({
          media: media ? { ...media, duration } : null,
          rttm,
          refRTTM,
          srt,
          candidate: candidateFile,
          rttmKind,
          speakers: speakersRef.current,
          segments: segmentsRef.current,
          refSegments,
          missingRanges: waveMissingRangesRef.current,
        }),
        ...buildAnnotationSnapshot(segmentsRef.current, speakersRef.current),
      }
      try {
        window.localStorage.setItem(draftStorageKey, JSON.stringify(payload))
        setLastDraftSavedAt(savedAt)
        setDraftAvailable(true)
      } catch {
        setToast({ message: '自动草稿保存失败：浏览器本地存储空间不足或不可用' })
        window.setTimeout(() => setToast(null), 4500)
      }
    }, 700)
    return () => window.clearTimeout(timer)
  }, [candidateFile, draftStorageKey, duration, media, refRTTM, refSegments, rttm, rttmKind, selectedEpisodeId, selectedSegId, segments, speakers, srt])

  const applyDraftPayload = useCallback((payload: DraftPayload, mode: 'auto' | 'manual') => {
    restoreAnnotationSnapshot(payload)
    setLastDraftSavedAt(payload.savedAt)
    setDraftAvailable(true)
    setSelectedSegId(payload.selectedSegId)
    if (typeof payload.lastPlaybackTime === 'number' && Number.isFinite(payload.lastPlaybackTime)) {
      setCurrentTime(payload.lastPlaybackTime)
      if (videoRef.current) videoRef.current.currentTime = payload.lastPlaybackTime
    }
    setToast({
      message: mode === 'auto'
        ? `已自动恢复 ${episodeLabelFromId(payload.selectedEpisodeId)} 的上次标注草稿`
        : `已恢复 ${episodeLabelFromId(payload.selectedEpisodeId)} 的本地草稿`,
    })
    window.setTimeout(() => setToast(null), mode === 'auto' ? 4800 : 3500)
  }, [restoreAnnotationSnapshot])

  const restoreCurrentEpisodeDraft = useCallback(() => {
    try {
      const payload = parseDraftPayload(window.localStorage.getItem(draftStorageKey))
      if (!payload) {
        setToast({ message: '没有找到本集可恢复的工程草稿' })
        window.setTimeout(() => setToast(null), 3000)
        return
      }
      applyDraftPayload(payload, 'manual')
    } catch (error) {
      setToast({ message: `恢复草稿失败：${error instanceof Error ? error.message : '未知错误'}` })
      window.setTimeout(() => setToast(null), 4200)
    }
  }, [applyDraftPayload, draftStorageKey])

  useEffect(() => {
    if (bootDraftCheckedRef.current) return
    bootDraftCheckedRef.current = true
    try {
      const payload = parseDraftPayload(window.localStorage.getItem(draftStorageKey))
      if (!payload) return
      bootDraftRestoredRef.current = true
      applyDraftPayload(payload, 'auto')
      if (payload.sourceFiles.rttm) {
        setRTTM({ id: 'draft-rttm', name: payload.sourceFiles.rttm, url: '', matched: true })
      }
    } catch (error) {
      setToast({ message: `自动恢复草稿失败：${error instanceof Error ? error.message : '未知错误'}` })
      window.setTimeout(() => setToast(null), 4500)
    }
  }, [applyDraftPayload, draftStorageKey])

  // drag-n-drop upload (global)
  const [dragOver, setDragOver] = useState(false)
  // per-section upload inputs
  const mediaInputRef = useRef<HTMLInputElement>(null)
  const rttmInputRef = useRef<HTMLInputElement>(null)
  const refRttmInputRef = useRef<HTMLInputElement>(null)
  const srtInputRef = useRef<HTMLInputElement>(null)
  const candidateInputRef = useRef<HTMLInputElement>(null)
  const projectInputRef = useRef<HTMLInputElement>(null)
  const onDrop = useCallback((e: React.DragEvent)=>{
    e.preventDefault(); setDragOver(false)
    const files = Array.from(e.dataTransfer.files)
    handleFiles(files)
  },[])
  function handleFiles(files: File[], target?: 'sys'|'ref'|'candidate'|'project'){
    for(const f of files){
      const lowerName = f.name.toLowerCase()
      if(lowerName.endsWith('.json')){
        const url = URL.createObjectURL(f)
        const reader = new FileReader()
        reader.onload = () => {
          try {
            const raw = String(reader.result)
            let projectSnapshot: DraftPayload | null = null
            let importedReviewWorkspace: ReviewWorkspace | null = null
            if (target !== 'candidate') {
              try {
                const reviewPackage = parseReviewPackage(raw)
                if (reviewPackage) {
                  projectSnapshot = parseReviewProjectSnapshot(JSON.stringify(reviewPackage.project))
                  importedReviewWorkspace = reviewPackage.review
                } else {
                  projectSnapshot = parseReviewProjectSnapshot(raw)
                }
              } catch {
                projectSnapshot = null
              }
            }
            if (projectSnapshot) {
              URL.revokeObjectURL(url)
              episodeManuallySelectedRef.current = true
              setSelectedEpisodeId(projectSnapshot.selectedEpisodeId)
              restoreAnnotationSnapshot(projectSnapshot)
              setSelectedSegId(projectSnapshot.selectedSegId)
              setLastDraftSavedAt(projectSnapshot.savedAt)
              setDraftAvailable(true)
              if (importedReviewWorkspace) {
                setReviewWorkspace(ensureReviewSegments(importedReviewWorkspace, projectSnapshot.segments.map((segment) => segment.id)))
                setReviewRoundNumber(importedReviewWorkspace.rounds.find((round) => round.id === importedReviewWorkspace.active_round_id)?.number || 1)
                setWorkMode('inspect')
                setLeftCollapsed(true)
              } else if (workMode === 'inspect') {
                setReviewWorkspace(createReviewWorkspace({
                  episodeId: projectSnapshot.selectedEpisodeId,
                  segmentIds: projectSnapshot.segments.map((segment) => segment.id),
                  reviewerName,
                  roundNumber: reviewRoundNumber,
                }))
              }
              if (typeof projectSnapshot.lastPlaybackTime === 'number' && Number.isFinite(projectSnapshot.lastPlaybackTime)) {
                setCurrentTime(projectSnapshot.lastPlaybackTime)
                if (videoRef.current) videoRef.current.currentTime = projectSnapshot.lastPlaybackTime
              }
              if (projectSnapshot.sourceFiles.rttm) {
                setRTTM({ id: 'project-rttm', name: projectSnapshot.sourceFiles.rttm, url: '', matched: true })
              }
              setPackageNotice(`已从${importedReviewWorkspace ? '复核包' : '工程 JSON'}恢复 ${episodeLabelFromId(projectSnapshot.selectedEpisodeId)}，请重新上传媒体文件后继续播放与校对。`)
              setToast({ message: importedReviewWorkspace ? `已恢复复核包：${f.name}，全部检查痕迹已载入` : `已恢复工程 JSON：${f.name}，可继续上次标注` })
              window.setTimeout(()=>{ setToast(null) }, 4200)
              return
            }
            if (target === 'project') {
              throw new Error('这不是有效的标注工程或复核包，请选择 *_review_project.json、*_annotation_project.json 或 *_review_package.json')
            }

            const entries = parseCandidateJSON(raw)
            if (entries.length === 0) {
              throw new Error('没有解析到候选片段，请确认这是 subseg_match_results.json 或包含 top_5_speakers/top_5_faces 的 JSON')
            }
            setCandidateFile({ id: crypto.randomUUID(), name: f.name, url, entries })
            setToast({ message: `已载入 subseg JSON：${f.name}，候选片段 ${entries.length} 条` })
            window.setTimeout(()=>{ setToast(null) }, 3500)
          } catch (error) {
            URL.revokeObjectURL(url)
            setToast({ message: `${target === 'project' ? '工程 JSON' : 'subseg JSON'} 解析失败：${error instanceof Error ? error.message : '未知错误'}` })
            window.setTimeout(()=>{ setToast(null) }, 5000)
          }
        }
        reader.onerror = () => {
          URL.revokeObjectURL(url)
          setToast({ message: `无法读取 ${target === 'project' ? '工程 JSON' : 'JSON'} 文件：${f.name}` })
          window.setTimeout(()=>{ setToast(null) }, 5000)
        }
        reader.readAsText(f)
      } else if(target === 'candidate'){
        setToast({ message: 'subseg JSON 只能上传 .json 文件' })
        window.setTimeout(()=>{ setToast(null) }, 3500)
      } else if(lowerName.endsWith('.rttm')){
        const url = URL.createObjectURL(f)
        const reader = new FileReader()
        reader.onload = () => {
          const {segments, speakers} = parseRTTM(String(reader.result))
          const explicitTarget = target ?? (/\bref\b/i.test(f.name) ? 'ref' : 'sys')
          const isRefTarget = explicitTarget === 'ref'
          if(isRefTarget){
            setRefSegments(segments)
            setRefRTTM({ id: crypto.randomUUID(), name:f.name, url, matched: true })
          } else {
            setSegments(segments); setSpeakers(speakers)
            setRTTM({ id: crypto.randomUUID(), name:f.name, url, matched: true })
          }
        }
        reader.readAsText(f)
      } else if(lowerName.endsWith('.srt')){
        const url = URL.createObjectURL(f)
        const reader = new FileReader()
        reader.onload = () => {
          const subtitles = parseSRT(String(reader.result))
          setSRT({ id: crypto.randomUUID(), name: f.name, url, subtitles })
        }
        reader.readAsText(f)
      } else if(/\.(mp4|webm|mp3|wav|m4a)$/i.test(f.name)){
        const url = URL.createObjectURL(f)
        const type: MediaType = /\.(mp4|webm)$/i.test(f.name) ? 'video' : 'audio'
        setMedia({ id: crypto.randomUUID(), name: f.name, type, url, size: f.size })
        setWaveformSource({ url, name: f.name })
      }
    }
  }

  // Get current subtitle based on current time
  const currentSubtitle = useMemo(() => {
    if (!srt?.subtitles) return null
    return srt.subtitles.find(sub => currentTime >= sub.start && currentTime < sub.end) || null
  }, [srt, currentTime])

  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.playbackRate = playbackRate;
    }
  }, [playbackRate])

  // Default tracks when no RTTM is loaded
  const defaultTracks = useMemo(() => {
    if (speakers.length > 0) return []
    const palette = ['#3B82F6','#EF4444','#10B981','#F59E0B','#8B5CF6','#06B6D4','#84CC16','#EC4899','#14B8A6','#F472B6']
    return Array.from({length: 10}).map((_, i) => ({
      id: `default-${i+1}`,
      name: `Track ${i+1}`,
      color: palette[i % palette.length],
      visible: true,
    }))
  }, [speakers.length])

  // All tracks (RTTM speakers + default tracks)
  const allTracks = useMemo(() => {
    if (speakers.length > 0) return speakers
    return defaultTracks
  }, [speakers, defaultTracks])

  const sortedSegmentRows = useMemo(
    () => segments.slice().sort((a, b) => a.start - b.start).map((segment, index) => ({ segment, index })),
    [segments],
  )
  const selectedSegmentRowNumber = useMemo(() => {
    if (!selectedSegId) return 0
    const selectedIndex = sortedSegmentRows.findIndex(({ segment }) => segment.id === selectedSegId)
    return selectedIndex >= 0 ? selectedIndex + 1 : 0
  }, [selectedSegId, sortedSegmentRows])
  const filteredSegmentRows = useMemo(() => {
    return filterDialogueRows(sortedSegmentRows, {
      status: segmentStatusFilter,
      speakerId: segmentSpeakerFilter,
    })
  }, [segmentSpeakerFilter, segmentStatusFilter, sortedSegmentRows])
  const filteredPlaybackQueue = useMemo(() => {
    if (segmentSpeakerFilter === 'all') return []
    return filteredSegmentRows.map(({ segment }) => ({
      id: segment.id,
      start: segment.start,
      end: segment.end,
    }))
  }, [filteredSegmentRows, segmentSpeakerFilter])
  const filteredPlaybackMode = segmentSpeakerFilter !== 'all'
  useEffect(() => {
    filteredPlaybackSessionRef.current = filteredPlaybackMode
  }, [filteredPlaybackMode, segmentSpeakerFilter])
  const dialogueRows = filteredSegmentRows
  const playbackSegmentRow = useMemo(
    () => sortedSegmentRows.find(({ segment }) => currentTime >= segment.start && currentTime < segment.end) ?? null,
    [currentTime, sortedSegmentRows],
  )
  const activePlaybackSegmentRow = useMemo(() => {
    if (playbackSegmentRow) return playbackSegmentRow
    let previousRow: { segment: Segment; index: number } | null = null
    for (const row of sortedSegmentRows) {
      if (row.segment.start > currentTime) break
      previousRow = row
    }
    return previousRow
  }, [currentTime, playbackSegmentRow, sortedSegmentRows])
  const activePlaybackSegmentId = activePlaybackSegmentRow?.segment.id ?? null
  const scrollDialogueRowIntoView = useCallback((segmentId: string | null, block: ScrollLogicalPosition = 'center') => {
    if (!segmentId) return
    const container = dialogueListRef.current
    if (!container) return
    const rowIndex = dialogueRows.findIndex(({ segment }) => segment.id === segmentId)
    if (rowIndex < 0) return
    const rowTop = rowIndex * DIALOGUE_ROW_HEIGHT
    const rowBottom = rowTop + DIALOGUE_ROW_HEIGHT
    const visibleTop = container.scrollTop
    const visibleBottom = visibleTop + container.clientHeight
    let nextTop = rowTop
    if (block === 'center') {
      nextTop = rowTop - (container.clientHeight - DIALOGUE_ROW_HEIGHT) / 2
    } else if (block === 'nearest' && rowTop >= visibleTop && rowBottom <= visibleBottom) {
      return
    } else if (block === 'nearest' && rowBottom > visibleBottom) {
      nextTop = rowBottom - container.clientHeight
    }
    const maxTop = Math.max(0, dialogueRows.length * DIALOGUE_ROW_HEIGHT - container.clientHeight)
    nextTop = Math.max(0, Math.min(maxTop, nextTop))
    autoDialogueScrollingRef.current = true
    container.scrollTo({ top: nextTop, behavior: 'auto' })
    setDialogueScrollTop(nextTop)
    if (releaseAutoDialogueScrollRef.current !== null) {
      window.clearTimeout(releaseAutoDialogueScrollRef.current)
    }
    releaseAutoDialogueScrollRef.current = window.setTimeout(() => {
      autoDialogueScrollingRef.current = false
    }, 160)
  }, [dialogueRows])
  useEffect(() => {
    if (!followPlayback) return
    scrollDialogueRowIntoView(activePlaybackSegmentId, 'center')
  }, [activePlaybackSegmentId, followPlayback, scrollDialogueRowIntoView])
  useEffect(() => {
    if (!isPlaying || !followPlayback || !activePlaybackSegmentId) return
    setSelectedSegId((current) => current === activePlaybackSegmentId ? current : activePlaybackSegmentId)
  }, [activePlaybackSegmentId, followPlayback, isPlaying])
  useEffect(() => {
    if (followPlayback) return
    scrollDialogueRowIntoView(selectedSegId, 'nearest')
  }, [followPlayback, scrollDialogueRowIntoView, selectedSegId])
  const onDialogueListScroll = useCallback(() => {
    setDialogueScrollTop(dialogueListRef.current?.scrollTop ?? 0)
    setInlineSpeakerPicker(null)
    if (autoDialogueScrollingRef.current) return
    if (followPlayback) setFollowPlayback(false)
  }, [followPlayback])
  useEffect(() => {
    const container = dialogueListRef.current
    if (!container) return
    const update = () => {
      setDialogueViewportHeight(container.clientHeight || 480)
      setDialogueScrollTop(container.scrollTop || 0)
    }
    update()
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', update)
      return () => window.removeEventListener('resize', update)
    }
    const observer = new ResizeObserver(update)
    observer.observe(container)
    return () => observer.disconnect()
  }, [dialogueRows.length, rightCollapsed])
  const virtualDialogueRows = useMemo(() => {
    const total = dialogueRows.length
    const startIndex = Math.max(0, Math.floor(dialogueScrollTop / DIALOGUE_ROW_HEIGHT) - DIALOGUE_OVERSCAN_ROWS)
    const endIndex = Math.min(
      total,
      Math.ceil((dialogueScrollTop + dialogueViewportHeight) / DIALOGUE_ROW_HEIGHT) + DIALOGUE_OVERSCAN_ROWS,
    )
    return {
      rows: dialogueRows.slice(startIndex, endIndex),
      topPadding: startIndex * DIALOGUE_ROW_HEIGHT,
      bottomPadding: Math.max(0, (total - endIndex) * DIALOGUE_ROW_HEIGHT),
    }
  }, [dialogueRows, dialogueScrollTop, dialogueViewportHeight])
  const reviewProgress = useMemo(() => {
    const counts: Record<ReviewStatus, number> = {
      pending: 0,
      checked: 0,
      corrected: 0,
      inserted: 0,
      deleted: 0,
      uncertain: 0,
    }
    for (const segment of segments) {
      counts[segment.reviewStatus || 'pending'] += 1
    }
    const reviewed = counts.checked + counts.corrected + counts.inserted + counts.deleted
    const denominator = Math.max(1, segments.length)
    return {
      counts,
      total: segments.length,
      reviewed,
      percent: Math.round((reviewed / denominator) * 100),
    }
  }, [segments])
  const filteredPendingCount = useMemo(
    () => filteredSegmentRows.filter(({ segment }) => (segment.reviewStatus || 'pending') === 'pending').length,
    [filteredSegmentRows],
  )
  const bundledEpisodeAssets = useMemo(() => summarizeBundledEpisodeAssets({
    episodeId: selectedEpisodeId,
    mediaKeys: Object.keys(defaultMediaFiles),
    rttmKeys: Object.keys(defaultRttmFiles),
    srtKeys: Object.keys(defaultSrtFiles),
    subsegKeys: Object.keys(defaultCandidateFiles),
  }), [selectedEpisodeId])
  // right panel auto collapse/expand logic based on data presence
  const hasRTTM = useMemo(()=> (!!rttm) || speakers.length>0, [rttm, speakers.length])
  const hasRef = useMemo(()=> (!!refRTTM) || refSegments.length>0, [refRTTM, refSegments.length])
  const hasSRT = useMemo(()=> !!srt, [srt])
  const currentEpisodeLabel = useMemo(
    () => inferEpisodeLabel([media?.name, rttm?.name, refRTTM?.name, srt?.name, candidateFile?.name]),
    [media?.name, rttm?.name, refRTTM?.name, srt?.name, candidateFile?.name],
  )
  useEffect(() => {
    if (bootDraftRestoredRef.current) return
    if (!episodeManuallySelectedRef.current && currentEpisodeLabel !== '未识别') {
      setSelectedEpisodeId(currentEpisodeLabel.replace(/^EP/i, ''))
    }
  }, [currentEpisodeLabel])
  const episodeRequirementRows = useMemo(() => {
    const makeState = (name: string | undefined, optional = false) => {
      if (!name) return optional ? 'optional-missing' : 'missing'
      return fileMatchesEpisode(name, selectedEpisodeId) ? 'loaded' : 'mismatch'
    }
    return [
      {
        key: 'media',
        label: '视频/音频',
        required: true,
        name: media?.name,
        detail: media ? formatTime(duration || media.duration || 0) : '用于播放、听音和波峰分析',
        state: makeState(media?.name),
        action: () => mediaInputRef.current?.click(),
      },
      {
        key: 'rttm',
        label: rttmKindLabel,
        required: true,
        name: rttm?.name,
        detail: rttm
          ? `${segments.length} segments · ${rttmKindLabel}`
          : `${rttmKindLabel}：${episodePackage.expected.rttm.join(' / ')}`,
        state: makeState(rttm?.name),
        action: () => rttmInputRef.current?.click(),
      },
      {
        key: 'srt',
        label: 'SRT',
        required: true,
        name: srt?.name,
        detail: srt ? `${srt.subtitles.length} subtitles` : '台词文本和字幕上下文',
        state: makeState(srt?.name),
        action: () => srtInputRef.current?.click(),
      },
      {
        key: 'subseg',
        label: 'subseg JSON',
        required: false,
        name: candidateFile?.name,
        detail: candidateFile
          ? `${candidateFile.entries.length} matches`
          : `声纹/人脸候选证据，建议：${episodePackage.expected.subseg[0]}`,
        state: candidateFile ? 'loaded' : 'optional-missing',
        action: () => candidateInputRef.current?.click(),
      },
      {
        key: 'ref',
        label: 'Ref RTTM',
        required: false,
        name: refRTTM?.name,
        detail: refRTTM ? `${refSegments.length} ref segments` : '可选，用于 DER/参考对比',
        state: makeState(refRTTM?.name, true),
        action: () => refRttmInputRef.current?.click(),
      },
    ] as const
  }, [candidateFile, duration, episodePackage, media, refRTTM, refSegments.length, rttm, rttmKindLabel, segments.length, selectedEpisodeId, srt])
  const missingRequiredCount = useMemo(
    () => episodeRequirementRows.filter((row) => row.required && row.state !== 'loaded').length,
    [episodeRequirementRows],
  )
  const isReadyForAnnotation = missingRequiredCount === 0
  const requiredLoadedCount = episodeRequirementRows.filter((row) => row.required && row.state === 'loaded').length
  const requiredTotalCount = episodeRequirementRows.filter((row) => row.required).length
  const modeLabel = workMode === 'prepare' ? '准备模式' : workMode === 'annotate' ? '标注模式' : '检查模式'
  const effectiveReviewWorkspace = useMemo(() => reviewWorkspace ?? createReviewWorkspace({
    episodeId: selectedEpisodeId,
    segmentIds: segments.map((segment) => segment.id),
    reviewerName,
    roundNumber: reviewRoundNumber,
  }), [reviewRoundNumber, reviewWorkspace, reviewerName, segments, selectedEpisodeId])
  const reviewSummary = useMemo(
    () => summarizeReviewWorkspace(effectiveReviewWorkspace),
    [effectiveReviewWorkspace],
  )
  const reviewIssueMarkers = useMemo(() => {
    if (!reviewWorkspace) return []
    return segments.flatMap((segment) => {
      const state = reviewWorkspace.segment_states[segment.id]
      if (!state || !['issue_open', 'awaiting_annotator', 'annotator_replied'].includes(state.status)) return []
      const event = getLatestReviewEvent(reviewWorkspace, segment.id)
      return [{
        id: segment.id,
        time: (event?.evidence_time_ms ?? Math.round(segment.start * 1000)) / 1000,
        status: state.status,
        label: event?.reason || '复核问题',
      }]
    })
  }, [reviewWorkspace, segments])
  const episodeOptions = useMemo(
    () => Array.from({ length: 30 }, (_, index) => normalizeEpisodeId(index + 1)),
    [],
  )
  useEffect(() => {
    if (workMode === 'inspect') {
      setRightCollapsed(false)
      setLeftCollapsed(true)
      return
    }
    if (!isReadyForAnnotation) {
      hasAutoEnteredAnnotationRef.current = false
      setWorkMode('prepare')
      setLeftCollapsed(false)
      setRightCollapsed(!hasRTTM && !hasSRT)
      return
    }
    setRightCollapsed(false)
    if (!hasAutoEnteredAnnotationRef.current) {
      hasAutoEnteredAnnotationRef.current = true
      setWorkMode('annotate')
      if (!resourcePanelManuallyChangedRef.current) setLeftCollapsed(true)
    }
  }, [hasRTTM, hasSRT, isReadyForAnnotation, segments.length, workMode])
  const toggleResourcePanel = useCallback(() => {
    resourcePanelManuallyChangedRef.current = true
    setLeftCollapsed((value) => !value)
  }, [])
  const changeWorkMode = useCallback((mode: WorkMode) => {
    setWorkMode(mode)
    if (mode === 'prepare') {
      resourcePanelManuallyChangedRef.current = true
      setLeftCollapsed(false)
    } else if (mode === 'inspect' || isReadyForAnnotation) {
      resourcePanelManuallyChangedRef.current = true
      setLeftCollapsed(true)
      setRightCollapsed(false)
    }
  }, [isReadyForAnnotation])

  // playback controls below video (requirement 2)
  const togglePlay = () => {
    const el = videoRef.current
    if(!el) return
    if(el.paused){
      setFollowPlayback(true)
      if (filteredPlaybackMode && filteredPlaybackSessionRef.current) {
        const step = getFilteredPlaybackStep(filteredPlaybackQueue, el.currentTime, { wrapToFirst: true })
        if (step.type === 'pause') {
          setToast({ message: '当前筛选条件下没有可播放片段' })
          window.setTimeout(() => setToast(null), 2600)
          return
        }
        if (step.type === 'seek') {
          el.currentTime = step.time
          setCurrentTime(step.time)
          setSelectedSegId(step.segmentId)
        } else if (step.segmentId) {
          setSelectedSegId(step.segmentId)
        }
      }
      el.playbackRate = playbackRate
      void el.play().catch(() => setIsPlaying(false))
      setIsPlaying(true)
    } else {
      el.pause()
      setIsPlaying(false)
    }
  }
  const seek = (t:number, options: { preserveFilteredPlayback?: boolean } = {}) => {
    const el = videoRef.current; if(!el) return
    filteredPlaybackSessionRef.current = getFilteredPlaybackSessionAfterSeek(
      filteredPlaybackSessionRef.current,
      options,
    )
    const nextTime = Math.max(0, Math.min(t, duration||el.duration||0))
    el.currentTime = nextTime
    setCurrentTime(nextTime)
  }
  const jumpToNextStatus = (status: ReviewStatus = 'pending') => {
    const rows = sortedSegmentRows.filter(({ segment }) => (segment.reviewStatus || 'pending') === status)
    if (rows.length === 0) return
    const afterCurrent = rows.find(({ segment }) => segment.start > currentTime + 0.03)
    const target = afterCurrent || rows[0]
    setSelectedSegId(target.segment.id)
    seek(target.segment.start)
  }
  const markSelectedAsChecked = () => {
    if (!selectedSegment) return
    updateSelectedSegment({
      reviewStatus: getReviewStatusAfterPass(selectedSegment.reviewStatus),
    })
  }
  const openInlineSpeakerPicker = (
    segment: Segment,
    anchor: { left: number; right: number; top: number; bottom: number },
    mode: 'assign' | 'add' = 'assign',
    seekToSegment = true,
  ) => {
    const pickerWidth = Math.min(580, Math.max(300, window.innerWidth - 24))
    const pickerHeight = Math.min(560, Math.max(360, window.innerHeight * 0.65))
    const position = getSpeakerPickerPosition(
      anchor,
      { width: window.innerWidth, height: window.innerHeight },
      { width: pickerWidth, height: pickerHeight },
    )
    setFollowPlayback(false)
    filteredPlaybackSessionRef.current = false
    setSelectedSegId(segment.id)
    if (seekToSegment) seek(segment.start)
    setInlineSpeakerPicker({ segmentId: segment.id, mode, query: '', ...position })
  }
  const assignSpeakerToSegment = (
    segmentId: string,
    speaker: Speaker,
    strategy = 'manual_speaker_inline_assign',
  ) => {
    const previousSegment = segmentsRef.current.find((segment) => segment.id === segmentId)
    if (!previousSegment || previousSegment.speakerId === speaker.id) {
      setInlineSpeakerPicker(null)
      return
    }
    const previousSnapshot = cloneSegments([previousSegment])[0]
    const previousSpeaker = speakersRef.current.find((item) => item.id === previousSegment.speakerId)
    const nextReviewStatus = getReviewStatusAfterSegmentPatch(previousSegment, { speakerId: speaker.id })
    setSegments((currentSegments) => currentSegments.map((segment) => {
      if (segment.id !== segmentId) return segment
      const patch: Partial<Segment> = {
        speakerId: speaker.id,
        evidence: { fusion: { role: speaker.name, strategy } },
      }
      return {
        ...segment,
        ...preserveOriginalSegmentFields(segment, patch, getSegmentDisplayText(segment)),
        ...patch,
        reviewStatus: nextReviewStatus,
        evidence: { ...segment.evidence, ...patch.evidence },
      }
    }))
    setRecentSpeakerIds((current) => updateRecentSpeakerIds(current, speaker.id))
    setInlineSpeakerPicker(null)
    const speakerChangeToast = {
      message: `说话人已由“${previousSpeaker?.name || previousSegment.speakerId}”改为“${speaker.name}”，${nextReviewStatus === 'inserted' ? '人工漏句状态保持为 inserted' : `状态已标记为 ${nextReviewStatus}`}`,
      actionLabel: '撤销',
      onAction: () => {
        setSegments((currentSegments) => currentSegments.map((segment) => (
          segment.id === segmentId ? previousSnapshot : segment
        )))
        setToast(null)
      },
    }
    setToast(speakerChangeToast)
    window.setTimeout(() => {
      setToast((current) => current === speakerChangeToast ? null : current)
    }, 6000)
  }
  const addInlineSpeakerAndAssign = () => {
    if (!inlineSpeakerPickerSegment || !inlineSpeakerPicker?.query.trim()) return
    const query = inlineSpeakerPicker.query.trim()
    const existing = speakers.find((speaker) => speaker.id === query || speaker.name === query)
    const speaker = existing || addSpeaker(query, 'manual')
    assignSpeakerToSegment(inlineSpeakerPickerSegment.id, speaker, 'manual_new_speaker_inline_assign')
  }
  const addInlineSpeakerOnly = () => {
    const query = inlineSpeakerPicker?.query.trim()
    if (!query) return
    const existing = speakers.find((speaker) => speaker.id === query || speaker.name === query)
    if (existing) {
      setToast({ message: `说话人“${existing.name}”已经存在，可直接选择使用。` })
      window.setTimeout(() => setToast(null), 3200)
      return
    }
    const speaker = addSpeaker(query, 'manual')
    setRecentSpeakerIds((current) => updateRecentSpeakerIds(current, speaker.id))
    setInlineSpeakerPicker(null)
    setToast({ message: `已新增说话人“${speaker.name}”，尚未修改当前台词。` })
    window.setTimeout(() => setToast(null), 3200)
  }
  const markFilteredPendingRowsAsChecked = () => {
    const rows = filteredSegmentRows
    const targetIds = new Set(
      rows
        .filter(({ segment }) => (segment.reviewStatus || 'pending') === 'pending')
        .map(({ segment }) => segment.id),
    )
    if (targetIds.size === 0) return
    setSegments((prev) => prev.map((segment) => (
      targetIds.has(segment.id)
        ? {
            ...segment,
            reviewStatus: 'checked',
            notes: segment.notes || 'Batch checked from annotation queue',
          }
        : segment
    )))
    setToast({ message: `已将 ${targetIds.size} 条 pending 标记为 checked` })
    window.setTimeout(() => setToast(null), 3200)
  }
  const onTimeUpdate = () => {
    const el = videoRef.current; if(!el) return
    if(el.duration && el.duration !== duration) setDuration(el.duration)
    const nextTime = el.currentTime
    if (isPlaying && filteredPlaybackMode && filteredPlaybackSessionRef.current) {
      const step = getFilteredPlaybackStep(filteredPlaybackQueue, nextTime)
      if (step.type === 'seek') {
        el.currentTime = step.time
        setCurrentTime(step.time)
        setSelectedSegId(step.segmentId)
        return
      }
      if (step.type === 'pause') {
        el.pause()
        setIsPlaying(false)
        setCurrentTime(nextTime)
        return
      }
      if (step.segmentId) {
        const activeSegmentId = step.segmentId
        setSelectedSegId((current) => current === activeSegmentId ? current : activeSegmentId)
      }
    }
    setCurrentTime(nextTime)
  }
  const onLoadedMetadata = () => {
    const el = videoRef.current; if(!el) return
    setDuration(el.duration || 0)
  }

  // Load bundled episode work-package files from exp/ folders when the episode changes.
  useEffect(()=>{
    if(lastAutoLoadedEpisodeRef.current === selectedEpisodeId) return
    lastAutoLoadedEpisodeRef.current = selectedEpisodeId
    try {
      const restoredDraft = bootDraftRestoredRef.current && !episodeManuallySelectedRef.current
      const loaded: string[] = []
      const missing: string[] = []
      const episodeKeys = (keys: string[]) => keys.filter((key) => {
        const fileName = key.split('/').pop() || key
        return fileMatchesEpisode(fileName, selectedEpisodeId)
      })

      const mediaKeys = Object.keys(defaultMediaFiles).sort()
      const episodeMediaKeys = episodeKeys(mediaKeys)
      if(mediaKeys.length > 0){
        const mp4First = episodeMediaKeys.find(k=>/\.mp4$/i.test(k)) || episodeMediaKeys[0]
        if (mp4First) {
          const url = defaultMediaFiles[mp4First]
          const name = mp4First.split('/').pop() || 'media'
          const type: MediaType = /\.(mp4|webm)$/i.test(name) ? 'video' : 'audio'
          setMedia({ id: 'default-media', name, type, url })
          const mediaBase = name.replace(/\.[^/.]+$/, '').toLowerCase()
          const audioFirst = episodeMediaKeys.find((key) => {
            const fileName = key.split('/').pop() || ''
            return /\.(wav|mp3|m4a)$/i.test(fileName) && fileName.replace(/\.[^/.]+$/, '').toLowerCase() === mediaBase
          }) || episodeMediaKeys.find((key) => /\.(wav|mp3|m4a)$/i.test(key)) || mp4First
          setWaveformSource({
            url: defaultMediaFiles[audioFirst],
            name: audioFirst.split('/').pop() || name,
          })
          loaded.push('媒体')
        } else if (!restoredDraft) {
          setMedia(null)
          setWaveformSource(null)
          missing.push('媒体')
        }
      }

      const rttmKeys = Object.keys(defaultRttmFiles).sort()
      const episodeRttmKeys = episodeKeys(rttmKeys)
      if(rttmKeys.length > 0 && !restoredDraft){
        const firstPath = episodeRttmKeys[0]
        if (firstPath) {
          const content = defaultRttmFiles[firstPath]
          const name = firstPath.split('/').pop() || 'segments.rttm'
          const parsed = parseRTTM(content)
          setSegments(parsed.segments)
          setSpeakers(parsed.speakers)
          const blob = new Blob([content], {type:'text/plain'})
          const url = URL.createObjectURL(blob)
          setRTTM({ id: 'default-rttm', name, url, matched: true })
          loaded.push(rttmKindLabel)
        } else {
          setSegments([])
          setSpeakers([])
          setRTTM(null)
          missing.push(rttmKindLabel)
        }
      } else if (restoredDraft) {
        missing.push('RTTM 原文件需按需重新上传')
      }

      const srtKeys = Object.keys(defaultSrtFiles).sort()
      const episodeSrtKeys = episodeKeys(srtKeys)
      if(srtKeys.length > 0){
        const firstPath = episodeSrtKeys[0]
        if (firstPath) {
          const content = defaultSrtFiles[firstPath]
          const name = firstPath.split('/').pop() || 'subtitles.srt'
          const subtitles = parseSRT(content)
          const blob = new Blob([content], {type:'text/plain'})
          const url = URL.createObjectURL(blob)
          setSRT({ id: 'default-srt', name, url, subtitles })
          loaded.push('SRT')
        } else if (!restoredDraft) {
          setSRT(null)
          missing.push('SRT')
        }
      }

      const candidateKeys = Object.keys(defaultCandidateFiles).sort()
      const episodeCandidateKeys = episodeKeys(candidateKeys)
      if(candidateKeys.length > 0){
        const preferredPath = episodeCandidateKeys.find((key) => /subseg|match/i.test(key)) || episodeCandidateKeys[0]
        if (preferredPath) {
          const content = defaultCandidateFiles[preferredPath]
          const name = preferredPath.split('/').pop() || 'subseg_match_results.json'
          const entries = parseCandidateJSON(content)
          const blob = new Blob([content], {type:'application/json'})
          const url = URL.createObjectURL(blob)
          setCandidateFile({ id: 'default-candidate-json', name, url, entries })
          loaded.push('subseg JSON')
        } else if (!restoredDraft) {
          setCandidateFile(null)
          missing.push('subseg JSON')
        }
      }

      const loadedText = loaded.length > 0 ? loaded.join('、') : '未找到本地匹配文件'
      const missingText = missing.length > 0 ? missing.join('、') : '无'
      setPackageNotice(`${episodePackage.label} 工作包：已自动加载 ${loadedText}；仍需上传 ${missingText}。`)
    } catch (e) {
      setPackageNotice(`工作包自动加载失败：${e instanceof Error ? e.message : '未知错误'}`)
    }
  }, [episodePackage.label, rttmKindLabel, selectedEpisodeId])

  // Keep playback UI responsive without forcing a full React render every frame.
  useEffect(()=>{
    if (!isPlaying) return
    const timer = window.setInterval(() => {
      const el = videoRef.current
      if(el){ setCurrentTime(el.currentTime) }
    }, 180)
    return ()=> window.clearInterval(timer)
  }, [isPlaying])

  // prev/next segment buttons logic
  const visibleSegments = useMemo(()=>{
    const visibleSpk = new Set(speakers.filter(s=>s.visible).map(s=>s.id))
    return segments.filter(s=>visibleSpk.has(s.speakerId))
  }, [segments, speakers])
  const jumpPrev = () => {
    const before = visibleSegments.filter(s => s.start < currentTime - 0.05)
    if(before.length === 0) { seek(0); return }
    const target = before[before.length-1]
    seek(target.start)
  }
  const jumpNext = () => {
    const after = visibleSegments.filter(s => s.start > currentTime + 0.05)
    if(after.length === 0) { seek(duration); return }
    const target = after[0]
    seek(target.start)
  }

  // zoom buttons
  const zoomOut = ()=> setZoom(z => Math.max(0.25, +(z-0.25).toFixed(2)))
  const zoomIn = ()=> setZoom(z => Math.min(10, +(z+0.25).toFixed(2)))

  // keyboard
  useEffect(()=>{
    const onKey = (e: KeyboardEvent) => {
      const suppressGlobalShortcut = shouldSuppressGlobalShortcut(e, document.activeElement)
      if((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !suppressGlobalShortcut){
        e.preventDefault()
        if(e.shiftKey) redoAnnotation()
        else undoAnnotation()
        return
      }
      if((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y' && !suppressGlobalShortcut){
        e.preventDefault()
        redoAnnotation()
        return
      }
      if(suppressGlobalShortcut) return
      if(e.code === 'Space'){ console.log('Space'); e.preventDefault(); togglePlay() }
      if(e.key === 'ArrowLeft'){ console.log('ArrowLeft'); seek(currentTime - 1) }
      if(e.key === 'ArrowRight'){ console.log('ArrowRight'); seek(currentTime + 1) }
      if((e.ctrlKey||e.metaKey) && (e.key==='=' || e.key==='+')) zoomIn()
      if((e.ctrlKey||e.metaKey) && e.key==='-') zoomOut()
      if(e.key === 'Delete' || e.key === 'Backspace'){
        console.log('Delete/Backspace pressed, selectedSegId=', selectedSegId)
        // Ignore Delete when user is typing in an editable element
        if(selectedSegId && !confirmDelete){
          e.preventDefault();
          console.log('Open confirm delete for', selectedSegId)
          setConfirmDelete({ open: true, segId: selectedSegId })
        } else { console.log('No segment selected, ignore delete') }
      }
      if(confirmDelete?.open && e.key === 'Enter'){
        console.log('Enter confirm delete')
        e.preventDefault()
        const targetId = confirmDelete.segId
        removeTimeSegment(targetId)
        setConfirmDelete(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return ()=> window.removeEventListener('keydown', onKey)
  }, [currentTime, duration, selectedSegId, confirmDelete, redoAnnotation, undoAnnotation])

  // timeline dims
  const pxPerSec = 80 * zoom
  const timelineWidth = Math.max(400, Math.ceil((duration||60) * pxPerSec))
  
  // Calculate optimal time division based on zoom level
  const timeDivision = useMemo(() => {
    if (zoom >= 8) return 1/60 // ~frame-level at 60fps
    if (zoom >= 6) return 1/30 // frame-level at 30fps
    if (zoom >= 4) return 0.1  // 100ms
    if (zoom >= 2) return 0.5  // 500ms
    if (zoom >= 1) return 1    // 1s
    if (zoom >= 0.5) return 2  // 2s
    return 5                   // 5s
  }, [zoom])

  const trackCount = speakers.length>0 ? speakers.length : Math.min(4, 10) // 默认最多显示4个空轨道
  const hasRefTrackVisible = showRefTrack && refSegments.length > 0
  const actualTrackCount = trackCount + (hasRefTrackVisible ? 1 : 0)
  const subtitleTrackHeight = hasSRT ? SUBTITLE_TRACK_HEIGHT : 0
  const visibleSpeakerTrackCount = Math.min(
    MAX_VISIBLE_SPEAKER_TRACKS,
    Math.max(2, actualTrackCount),
  )
  const speakerTrackViewportHeight = visibleSpeakerTrackCount * SPEAKER_TRACK_HEIGHT
  const timelineContentHeight =
    TIMELINE_RULER_HEIGHT + WAVEFORM_HEIGHT + subtitleTrackHeight + speakerTrackViewportHeight

  // click timeline seek / missing-dialogue time picking
  const waveRef = useRef<HTMLDivElement>(null)
  const waveChunkRefs = useRef<Map<number, HTMLCanvasElement>>(new Map())
  const [timelineViewport, setTimelineViewport] = useState({ scrollLeft: 0, width: 1200 })
  const syncTimelineViewport = useCallback(() => {
    const el = waveRef.current
    if (!el) return
    const next = { scrollLeft: el.scrollLeft, width: el.clientWidth || 1200 }
    setTimelineViewport((prev) => (
      Math.abs(prev.scrollLeft - next.scrollLeft) < 24 && Math.abs(prev.width - next.width) < 24
        ? prev
        : next
    ))
  }, [])
  const onTimelineScroll = useCallback(() => {
    syncTimelineViewport()
  }, [syncTimelineViewport])
  useEffect(() => {
    const frame = window.requestAnimationFrame(syncTimelineViewport)
    window.addEventListener('resize', syncTimelineViewport)
    return () => {
      window.cancelAnimationFrame(frame)
      window.removeEventListener('resize', syncTimelineViewport)
    }
  }, [leftCollapsed, rightCollapsed, syncTimelineViewport, timelineWidth])
  const visibleTimelineRange = useMemo(() => {
    const totalDuration = duration || 60
    const overscanPx = Math.max(640, timelineViewport.width)
    return {
      start: Math.max(0, (timelineViewport.scrollLeft - overscanPx) / pxPerSec),
      end: Math.min(totalDuration, (timelineViewport.scrollLeft + timelineViewport.width + overscanPx) / pxPerSec),
    }
  }, [duration, pxPerSec, timelineViewport.scrollLeft, timelineViewport.width])
  const visibleMajorTicks = useMemo(() => {
    const totalDuration = duration || 0
    if (totalDuration <= 0) return [] as Array<{ time: number; left: number; major: boolean; showLabel: boolean }>
    const startIndex = Math.max(0, Math.floor(visibleTimelineRange.start / timeDivision))
    const endIndex = Math.min(Math.ceil(totalDuration / timeDivision), Math.ceil(visibleTimelineRange.end / timeDivision))
    const maxTicks = 900
    const step = Math.max(1, Math.ceil((endIndex - startIndex + 1) / maxTicks))
    const ticks: Array<{ time: number; left: number; major: boolean; showLabel: boolean }> = []
    for (let i = startIndex; i <= endIndex; i += step) {
      const time = i * timeDivision
      const major = i % 5 === 0
      const isLastLabel = time >= totalDuration - timeDivision * 0.5
      ticks.push({ time, left: time * pxPerSec, major, showLabel: major && !isLastLabel })
    }
    return ticks
  }, [duration, pxPerSec, timeDivision, visibleTimelineRange.end, visibleTimelineRange.start])
  const visibleMinorTicks = useMemo(() => {
    const totalDuration = duration || 0
    const minorDiv = timeDivision / 5
    if (totalDuration <= 0 || minorDiv <= 0 || minorDiv * pxPerSec < 8) {
      return [] as Array<{ time: number; left: number }>
    }
    const startIndex = Math.max(0, Math.floor(visibleTimelineRange.start / minorDiv))
    const endIndex = Math.min(Math.ceil(totalDuration / minorDiv), Math.ceil(visibleTimelineRange.end / minorDiv))
    const maxTicks = 1200
    const step = Math.max(1, Math.ceil((endIndex - startIndex + 1) / maxTicks))
    const ticks: Array<{ time: number; left: number }> = []
    for (let i = startIndex; i <= endIndex; i += step) {
      const time = i * minorDiv
      const isMajorAligned = Math.abs(time % timeDivision) < 1e-6
      if (!isMajorAligned) ticks.push({ time, left: time * pxPerSec })
    }
    return ticks
  }, [duration, pxPerSec, timeDivision, visibleTimelineRange.end, visibleTimelineRange.start])
  const toTimeFromClientX = (clientX: number) => {
    const el = waveRef.current; if(!el) return 0
    const rect = el.getBoundingClientRect()
    const x = clientX - rect.left + el.scrollLeft
    return Math.max(0, Math.min((duration||0), x / pxPerSec))
  }
  const isTimelineScrollbarPointer = (clientY: number) => {
    const el = waveRef.current; if(!el) return false
    const rect = el.getBoundingClientRect()
    const horizontalScrollbarHeight = Math.max(0, el.offsetHeight - el.clientHeight)
    if (horizontalScrollbarHeight === 0) return false

    // Native scrollbar drags should scroll the timeline only, not seek or pick times.
    return clientY >= rect.bottom - Math.max(12, horizontalScrollbarHeight + 2)
  }
  const suppressNextTimelineClick = () => {
    suppressTimelineClickRef.current = true
    window.setTimeout(() => {
      suppressTimelineClickRef.current = false
    }, 180)
  }
  const findSpeakerNameAtTime = (time: number) => {
    const match = sortedSegmentRows.find(({ segment }) => time >= segment.start && time < segment.end)
    if (!match) return undefined
    const speaker = speakers.find((item) => item.id === match.segment.speakerId)
    return speaker?.name || match.segment.speakerId
  }
  const showTimedToast = (message: string, timeout = 3200) => {
    setToast({ message })
    window.setTimeout(() => setToast(null), timeout)
  }
  const cancelTimeProbeFrame = () => {
    if (timeProbeFrameRef.current !== null) {
      window.cancelAnimationFrame(timeProbeFrameRef.current)
      timeProbeFrameRef.current = null
    }
    pendingTimeProbeRef.current = null
  }
  const clearTimeProbe = () => {
    cancelTimeProbeFrame()
    lastTimeProbeRef.current = null
    setTimeProbe(null)
  }
  const cancelMissingRangePreviewFrame = () => {
    if (missingRangePreviewFrameRef.current !== null) {
      window.cancelAnimationFrame(missingRangePreviewFrameRef.current)
      missingRangePreviewFrameRef.current = null
    }
    pendingMissingRangePreviewRef.current = null
  }
  const setMissingRangePreviewNow = (preview: { start: number; end: number } | null) => {
    cancelMissingRangePreviewFrame()
    setMissingRangePreview(preview)
  }
  const scheduleMissingRangePreview = (preview: { start: number; end: number }) => {
    pendingMissingRangePreviewRef.current = preview
    if (missingRangePreviewFrameRef.current !== null) return
    missingRangePreviewFrameRef.current = window.requestAnimationFrame(() => {
      const pending = pendingMissingRangePreviewRef.current
      pendingMissingRangePreviewRef.current = null
      missingRangePreviewFrameRef.current = null
      if (pending) setMissingRangePreview(pending)
    })
  }
  const sameGhostSegment = (
    a: {speakerId:string; start:number; end:number} | null,
    b: {speakerId:string; start:number; end:number} | null,
  ) => {
    if (!a || !b) return a === b
    return a.speakerId === b.speakerId && Math.abs(a.start - b.start) < 0.03 && Math.abs(a.end - b.end) < 0.03
  }
  const cancelGhostSegFrame = () => {
    if (ghostSegFrameRef.current !== null) {
      window.cancelAnimationFrame(ghostSegFrameRef.current)
      ghostSegFrameRef.current = null
    }
    pendingGhostSegRef.current = null
  }
  const setGhostSegNow = (next: {speakerId:string; start:number; end:number} | null) => {
    cancelGhostSegFrame()
    lastGhostSegRef.current = next
    setGhostSeg(next)
  }
  const scheduleGhostSeg = (next: {speakerId:string; start:number; end:number}) => {
    if (sameGhostSegment(lastGhostSegRef.current, next)) return
    pendingGhostSegRef.current = next
    if (ghostSegFrameRef.current !== null) return
    ghostSegFrameRef.current = window.requestAnimationFrame(() => {
      const pending = pendingGhostSegRef.current
      pendingGhostSegRef.current = null
      ghostSegFrameRef.current = null
      if (!pending || sameGhostSegment(lastGhostSegRef.current, pending)) return
      lastGhostSegRef.current = pending
      setGhostSeg(pending)
    })
  }
  const updateTimeProbeFromClient = (clientX: number) => {
    const time = toTimeFromClientX(clientX)
    const speakerName = findSpeakerNameAtTime(time)
    const previous = lastTimeProbeRef.current
    if (!previous || Math.abs(previous.time - time) >= 0.04 || previous.speakerName !== speakerName) {
      lastTimeProbeRef.current = { time, speakerName }
      pendingTimeProbeRef.current = { time, clientX, speakerName }
      if (timeProbeFrameRef.current === null) {
        timeProbeFrameRef.current = window.requestAnimationFrame(() => {
          const pending = pendingTimeProbeRef.current
          pendingTimeProbeRef.current = null
          timeProbeFrameRef.current = null
          if (pending) setTimeProbe(pending)
        })
      }
    }
    return time
  }
  const applyMissingPointAtTime = (mode: Exclude<MissingTimePickMode, 'idle' | 'range'>, time: number) => {
    const result = applyMissingTimePoint(missingInsertDraft, mode, time)
    setMissingInsertDraft((prev) => ({ ...prev, ...result.draft }))
    setMissingPickMode(mode === 'start' ? 'end' : 'idle')
    showTimedToast(mode === 'start' ? `${result.message}；请继续点击结束秒` : result.message)
  }
  const applyMissingRangeAtTimes = (start: number, end: number) => {
    const result = applyMissingTimeRange(missingInsertDraft, start, end)
    setMissingInsertDraft((prev) => ({ ...prev, ...result.draft }))
    setMissingPickMode('idle')
    setMissingRangePreviewNow(null)
    missingRangeAnchorRef.current = null
    showTimedToast(result.message)
  }
  const onClickTimeline = (e: React.MouseEvent) => {
    if (suppressTimelineClickRef.current || isTimelineScrollbarPointer(e.clientY)) {
      suppressTimelineClickRef.current = false
      return
    }
    if (missingPickMode !== 'idle') return
    seek(toTimeFromClientX(e.clientX))
  }

  // Pointer-based scrubbing (press-and-hold to move playhead)
  const scrubAtClient = (clientX: number) => {
    seek(toTimeFromClientX(clientX))
  }
  const onTimelinePointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    if (isTimelineScrollbarPointer(e.clientY)) {
      timelineScrollbarDragRef.current = true
      isScrubbingRef.current = false
      missingRangeAnchorRef.current = null
      setMissingRangePreviewNow(null)
      suppressNextTimelineClick()
      return
    }
    timelineScrollbarDragRef.current = false
    const time = updateTimeProbeFromClient(e.clientX)
    if (missingPickMode === 'start' || missingPickMode === 'end') {
      applyMissingPointAtTime(missingPickMode, time)
      e.preventDefault()
      return
    }
    if (missingPickMode === 'range') {
      missingRangeAnchorRef.current = time
      setMissingRangePreviewNow({ start: time, end: time })
      try { (e.currentTarget as Element).setPointerCapture?.(e.pointerId) } catch {}
      e.preventDefault()
      return
    }
    isScrubbingRef.current = true
    try { (e.currentTarget as Element).setPointerCapture?.(e.pointerId) } catch {}
    scrubAtClient(e.clientX)
    e.preventDefault()
  }
  const onTimelinePointerMove = (e: React.PointerEvent) => {
    if (timelineScrollbarDragRef.current) return
    if (!isScrubbingRef.current && missingRangeAnchorRef.current === null && isTimelineScrollbarPointer(e.clientY)) {
      return
    }
    const time = updateTimeProbeFromClient(e.clientX)
    if (missingRangeAnchorRef.current !== null) {
      scheduleMissingRangePreview({ start: missingRangeAnchorRef.current, end: time })
      return
    }
    if(!isScrubbingRef.current) return
    scrubAtClient(e.clientX)
  }
  const onTimelinePointerUp = (e: React.PointerEvent) => {
    if (timelineScrollbarDragRef.current) {
      timelineScrollbarDragRef.current = false
      suppressNextTimelineClick()
      return
    }
    if (missingRangeAnchorRef.current !== null) {
      const end = updateTimeProbeFromClient(e.clientX)
      applyMissingRangeAtTimes(missingRangeAnchorRef.current, end)
      try { (e.currentTarget as Element).releasePointerCapture?.(e.pointerId) } catch {}
      return
    }
    isScrubbingRef.current = false
    try { (e.currentTarget as Element).releasePointerCapture?.(e.pointerId) } catch {}
  }
  const onTimelinePointerLeave = () => {
    if (!isScrubbingRef.current && missingRangeAnchorRef.current === null && !timelineScrollbarDragRef.current) {
      clearTimeProbe()
    }
  }
  useEffect(() => {
    return () => {
      if (segmentTextCommitTimerRef.current !== null) window.clearTimeout(segmentTextCommitTimerRef.current)
      if (segmentNotesCommitTimerRef.current !== null) window.clearTimeout(segmentNotesCommitTimerRef.current)
      if (timeProbeFrameRef.current !== null) window.cancelAnimationFrame(timeProbeFrameRef.current)
      if (missingRangePreviewFrameRef.current !== null) window.cancelAnimationFrame(missingRangePreviewFrameRef.current)
      if (ghostSegFrameRef.current !== null) window.cancelAnimationFrame(ghostSegFrameRef.current)
      segmentTextCommitTimerRef.current = null
      segmentNotesCommitTimerRef.current = null
      timeProbeFrameRef.current = null
      missingRangePreviewFrameRef.current = null
      ghostSegFrameRef.current = null
      pendingSegmentTextCommitRef.current = null
      pendingSegmentNotesCommitRef.current = null
      pendingTimeProbeRef.current = null
      pendingMissingRangePreviewRef.current = null
      pendingGhostSegRef.current = null
      lastGhostSegRef.current = null
    }
  }, [])

  // Helpers for drag/creation logic
  const MIN_DUR = 0.01 // 10ms

  const getSpeakerNeighborBounds = (speakerId: string, segId?: string) => {
    const list = segments.filter(s=>s.speakerId===speakerId).sort((a,b)=>a.start-b.start)
    let prevEnd = 0
    let nextStart = duration || Number.POSITIVE_INFINITY
    for(let i=0;i<list.length;i++){
      const s = list[i]
      if(segId && s.id===segId){
        if(i>0) prevEnd = list[i-1].end
        if(i<list.length-1) nextStart = list[i+1].start
        break
      }
    }
    if(!segId && list.length>0){
      // For creation we just use full bounds (no overlap across existing segments)
      // We will clamp later against nearest neighbors based on the new time
    }
    return {prevEnd, nextStart}
  }

  const updateSegmentTime = (segId: string, nextStart: number, nextEnd: number) => {
    setSegments(prev => {
      const target = prev.find(s=>s.id===segId)
      if(!target) return prev
      const {prevEnd, nextStart: ns} = getSpeakerNeighborBounds(target.speakerId, segId)
      const clampedStart = Math.max(prevEnd, Math.min(nextStart, ns - MIN_DUR))
      const clampedEnd = Math.max(clampedStart + MIN_DUR, Math.min(nextEnd, ns))
      return prev.map(s=> s.id===segId? {...s, start: clampedStart, end: clampedEnd}: s)
    })
  }

  const createSegmentAt = (
    speakerId: string,
    atTime: number,
    preset?: Partial<Segment>,
    options?: { preserveRange?: boolean },
  ) => {
    const id = crypto.randomUUID()
    const baseStart = atTime
    const baseEnd = preset?.end ?? Math.min((duration||atTime+1), atTime + 0.2)
    const newSeg: Segment = {
      id,
      speakerId,
      start: baseStart,
      end: baseEnd,
      text: '',
      origin: 'manual_insert',
      reviewStatus: 'inserted',
      segmentType: 'dialogue',
      evidence: { text: { source: 'manual', value: '' } },
      notes: 'Manual inserted segment',
      ...preset,
    }
    setSegments(prev => {
      if (options?.preserveRange) {
        return [...prev, newSeg].sort((a,b)=> a.start-b.start)
      }
      // Prevent overlap on insert by shrinking into nearest gap
      const list = prev.filter(s=>s.speakerId===speakerId).sort((a,b)=>a.start-b.start)
      let leftBound = 0
      let rightBound = duration || Number.POSITIVE_INFINITY
      for(let i=0;i<list.length;i++){
        const s = list[i]
        if(s.end <= atTime){ leftBound = Math.max(leftBound, s.end) }
        if(s.start >= atTime && rightBound=== (duration||Number.POSITIVE_INFINITY)){ rightBound = s.start }
      }
      const start = Math.max(leftBound, Math.min(newSeg.start, rightBound - MIN_DUR))
      const end = Math.max(start + MIN_DUR, Math.min(newSeg.end, rightBound))
      const adjusted = {...newSeg, start, end}
      return [...prev, adjusted].sort((a,b)=> a.start-b.start)
    })
    setSelectedSegId(id)
    return id
  }

  const insertMissingRange = (range: { start: number; end: number }) => {
    const speakerId = selectedSegment?.speakerId || speakers[0]?.id || 'UNKNOWN'
    if (!speakers.some((speaker) => speaker.id === speakerId)) {
      setSpeakers((prev) => [
        ...prev,
        { id: speakerId, name: speakerId, color: '#8B5CF6', visible: true, source: 'manual' },
      ])
    }
    const id = createSegmentAt(speakerId, range.start, {
      start: range.start,
      end: Math.max(range.start + MIN_DUR, range.end),
      reviewStatus: 'inserted',
      notes: 'Inserted from waveform suspected missing speech',
      evidence: {
        text: { source: 'manual', value: '' },
        waveform: { suspectedMissing: true },
      },
    }, { preserveRange: true })
    setSelectedSegId(id)
    seek(range.start)
    setToast({ message: '漏句已加入时间轴、右侧列表和工程草稿；导出时会进入 RTTM/JSON' })
    window.setTimeout(() => setToast(null), 4200)
  }

  const insertMissingDraft = () => {
    const start = Number(missingInsertDraft.start)
    const end = Number(missingInsertDraft.end)
    const text = missingInsertDraft.text.trim()
    const speakerId = missingInsertDraft.speakerId || selectedSegment?.speakerId || speakers[0]?.id || 'UNKNOWN'
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      setToast({ message: '漏句插入失败：请填写合法的开始和结束时间' })
      window.setTimeout(() => setToast(null), 4200)
      return
    }
    if (!speakers.some((speaker) => speaker.id === speakerId)) {
      setSpeakers((prev) => [
        ...prev,
        { id: speakerId, name: speakerId, color: '#8B5CF6', visible: true, source: 'manual' },
      ])
    }
    const id = createSegmentAt(speakerId, start, {
      start,
      end,
      text,
      reviewStatus: 'inserted',
      notes: text ? 'Manual inserted missing dialogue' : 'Manual inserted missing dialogue; text pending',
      evidence: {
        text: { source: 'manual', value: text },
        waveform: { suspectedMissing: true },
        fusion: { role: speakerId, strategy: 'manual_missing_dialogue_insert' },
      },
    }, { preserveRange: true })
    setMissingInsertDraft({ start: '', end: '', text: '', speakerId })
    setMissingPickMode('idle')
    setMissingRangePreviewNow(null)
    missingRangeAnchorRef.current = null
    setSelectedSegId(id)
    seek(start)
    setToast({ message: '漏句已加入时间轴、右侧列表和工程草稿；导出时会进入 RTTM/JSON' })
    window.setTimeout(() => setToast(null), 4200)
  }

  // Remove segment with optional undo
  const removeTimeSegment = (segId: string) => {
    const seg = segmentsRef.current.find(s=>s.id===segId) || null
    if(!seg) return
    lastDeletedRef.current = seg
    setSegments(prev => prev.filter(s=> s.id!==segId))
    setSelectedSegId(v => v===segId ? null : v)
    const undo = () => {
      const snap = lastDeletedRef.current
      if(!snap) return
      setSegments(prev => [...prev, snap].sort((a,b)=> a.start-b.start))
      lastDeletedRef.current = null
      setToast(null)
    }
    setToast({ message: '已删除一个时间段', actionLabel: '撤销', onAction: undo })
    window.setTimeout(()=>{ setToast(null) }, 5000)
  }

  // auto-scroll timeline to keep playhead in view (throttled, no repeated smooth to avoid jitter)
  const autoScrollStateRef = useRef<{ lastTs: number; lastLeft: number }>({ lastTs: 0, lastLeft: 0 })
  useEffect(()=>{
    const el = waveRef.current; if(!el) return
    const playheadX = currentTime * pxPerSec
    const viewLeft = el.scrollLeft
    const viewRight = viewLeft + el.clientWidth
    const margin = Math.max(60, el.clientWidth * 0.2)

    // Only scroll when the playhead is getting too close to the edges
    const isNearEdge = playheadX < viewLeft + margin || playheadX > viewRight - margin
    if(!isNearEdge) return

    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now())
    const { lastTs } = autoScrollStateRef.current
    if(now - lastTs < 80) return // throttle ~12.5 fps

    const targetLeft = Math.max(0, playheadX - el.clientWidth / 2)
    if(Math.abs(targetLeft - viewLeft) < 4) return // tiny changes ignored

    el.scrollLeft = targetLeft // immediate jump to avoid interrupting smooth scroll repeatedly
    syncTimelineViewport()
    autoScrollStateRef.current.lastTs = now
    autoScrollStateRef.current.lastLeft = targetLeft
  }, [currentTime, pxPerSec, syncTimelineViewport])

  // Vertical resize of video area
  const onResizeMouseDown = (e: React.MouseEvent) => {
    resizeStateRef.current = { startY: e.clientY, startH: videoAreaHeight }
    const onMove = (ev: MouseEvent) => {
      const start = resizeStateRef.current; if(!start) return
      const centerH = centerRef.current?.clientHeight || 600
      const minH = 140
      const maxH = Math.max(minH, centerH - 140)
      const next = Math.max(minH, Math.min(maxH, start.startH + (ev.clientY - start.startY)))
      setVideoAreaHeight(next)
    }
    const onUp = () => {
      resizeStateRef.current = null
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    e.preventDefault()
  }

  // tooltip on hover segment
  const [tooltip, setTooltip] = useState<{x:number;y:number;text:string}|null>(null)

  const validateBeforeExport = (target: string) => {
    const issues = buildExportIssues({
      segments,
      speakers,
      media,
      rttm,
      rttmKind,
      srt,
      candidateFile,
      selectedEpisodeId,
      waveMissingRanges,
    })
    setExportIssues(issues)
    if (issues.blocking.length > 0) {
      setToast({ message: `${target} 导出已停止：${issues.blocking[0]}` })
      window.setTimeout(() => setToast(null), 5000)
      return false
    }
    if (issues.warnings.length > 0) {
      setToast({ message: `${target} 已通过基础校验，但仍有 ${issues.warnings.length} 条提醒` })
      window.setTimeout(() => setToast(null), 4200)
    }
    return true
  }

  const buildCurrentProject = () => buildEpisodeProject({
      media: media ? { ...media, duration } : null,
      rttm,
      refRTTM,
      srt,
      candidate: candidateFile,
      rttmKind,
      speakers,
      segments,
      refSegments,
      missingRanges: waveMissingRanges,
    })

  // export project (segments + speakers) JSON
  const exportJSON = () => {
    if (!validateBeforeExport('工程 JSON')) return
    const data = buildCurrentProject()
    const blob = new Blob([JSON.stringify(data, null, 2)], {type:'application/json'})
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    const fileId = media?.name ? media.name.replace(/\.[^/.]+$/, '') : 'episode'
    a.href = url; a.download = `${fileId}_review_project.json`; a.click()
    URL.revokeObjectURL(url)
  }

  const exportReviewProgress = (status: 'draft' | 'submitted') => {
    if (segments.length === 0) {
      setToast({ message: '没有可保存的复核内容，请先导入标注工程。' })
      window.setTimeout(() => setToast(null), 3500)
      return
    }
    const data = buildReviewPackage({
      project: buildCurrentProject(),
      review: ensureReviewSegments(effectiveReviewWorkspace, segments.map((segment) => segment.id)),
      status,
    })
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    const fileId = episodeLabelFromId(selectedEpisodeId).toLowerCase()
    anchor.href = url
    anchor.download = `${fileId}_review_round${reviewRoundNumber}_${status === 'draft' ? 'progress' : 'package'}.json`
    anchor.click()
    URL.revokeObjectURL(url)
    setToast({ message: status === 'draft' ? '复核进度已保存，可在任何电脑导入后继续。' : '复核包已导出，包含标注工程和全部检查痕迹。' })
    window.setTimeout(() => setToast(null), 4200)
  }

  const handleReviewAction = useCallback((segment: ReviewDisplaySegment, request: ReviewActionRequest) => {
    const now = new Date().toISOString()
    setReviewWorkspace((current) => {
      let workspace = current?.episode_id === selectedEpisodeId
        ? ensureReviewSegments(current, segmentsRef.current.map((item) => item.id))
        : createReviewWorkspace({
            episodeId: selectedEpisodeId,
            segmentIds: segmentsRef.current.map((item) => item.id),
            reviewerName,
            roundNumber: reviewRoundNumber,
            now,
          })
      const activeRound = workspace.rounds.find((round) => round.id === workspace.active_round_id)
      const event: ReviewEvent = {
        id: crypto.randomUUID(),
        round_id: workspace.active_round_id,
        segment_id: segment.id,
        actor: {
          id: activeRound?.reviewer.id || `reviewer-${reviewerName || 'anonymous'}`,
          name: reviewerName.trim() || activeRound?.reviewer.name || '未命名复核人',
          role: 'reviewer',
        },
        action: request.action,
        issue_types: request.issueTypes,
        before: request.before,
        proposed_after: request.proposedAfter,
        reason: request.reason,
        evidence_time_ms: request.evidenceTimeMs,
        created_at: now,
      }
      workspace = appendReviewEvent(workspace, event)
      return workspace
    })
    const actionLabel = request.action === 'approved'
      ? '已通过本句'
      : request.action === 'resolved'
        ? '已确认回改并解决'
        : request.action === 'change_proposed'
          ? '修改建议已提交并留痕'
          : '问题已记录并留痕'
    setToast({ message: actionLabel })
    window.setTimeout(() => setToast(null), 2600)
  }, [reviewRoundNumber, reviewerName, selectedEpisodeId])

  const exportRTTM = () => {
    if (!validateBeforeExport('RTTM')) return
    const fileId = media?.name ? media.name.replace(/\.[^/.]+$/, '') : 'unknown'
    const lines = segments
      .slice()
      .sort((a,b)=> a.start-b.start)
      .filter((seg) => seg.reviewStatus !== 'deleted')
      .map(seg => {
        const dur = Math.max(MIN_DUR, seg.end - seg.start)
        const label = speakers.find(s=> s.id===seg.speakerId)?.name || seg.speakerId
        // SPEAKER <file_id> <chnl> <tbeg> <tdur> <ortho> <stype> <name> <conf>
        return `SPEAKER ${fileId} 1 ${seg.start.toFixed(3)} ${dur.toFixed(3)} <NA> <NA> ${label} <NA>`
      })
      .join('\n')
    const blob = new Blob([lines+'\n'], {type:'text/plain'})
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = `${fileId || 'segments'}.rttm`; a.click()
    URL.revokeObjectURL(url)
  }

  // Waveform generation from media
  const [wavePeaks, setWavePeaks] = useState<Float32Array | null>(null)
  const [waveFailed, setWaveFailed] = useState<boolean>(false)
  const [waveLoading, setWaveLoading] = useState<boolean>(false)
  const [waveMessage, setWaveMessage] = useState<string>('')
  const [waveRequestId, setWaveRequestId] = useState(0)
  const autoWaveformSourceRef = useRef<string | null>(null)
  const waveformTarget = useMemo(() => ({
    url: waveformSource?.url || media?.url || '',
    name: waveformSource?.name || media?.name || '',
  }), [media?.name, media?.url, waveformSource?.name, waveformSource?.url])

  const requestWaveformGeneration = useCallback(() => {
    if (!waveformTarget.url) {
      setToast({ message: '请先加载视频或音频文件，再生成波形。' })
      window.setTimeout(() => setToast(null), 2800)
      return
    }
    autoWaveformSourceRef.current = waveformTarget.url
    setWaveRequestId((value) => value + 1)
  }, [waveformTarget.url])

  useEffect(() => {
    setWavePeaks(null)
    setWaveFailed(false)
    setWaveLoading(false)
    setWaveMessage(waveformTarget.url ? '页面稳定后将自动生成波形；也可以点击“生成波形”立即开始。' : '')
  }, [waveformTarget.url, waveformTarget.name])

  useEffect(() => {
    const sourceUrl = waveformTarget.url
    if (!sourceUrl) {
      autoWaveformSourceRef.current = null
      return
    }
    if (autoWaveformSourceRef.current === sourceUrl) return

    const timer = window.setTimeout(() => {
      if (autoWaveformSourceRef.current === sourceUrl) return
      autoWaveformSourceRef.current = sourceUrl
      setWaveRequestId((value) => value + 1)
    }, 1500)

    return () => window.clearTimeout(timer)
  }, [waveformTarget.url])

  useEffect(() => {
    if (waveRequestId === 0) return
    let cancelled = false
    let audioContext: AudioContext | null = null
    const sourceUrl = waveformTarget.url
    if (!sourceUrl) return

    const loadWaveform = async () => {
      setWavePeaks(null)
      setWaveFailed(false)
      setWaveLoading(true)
      setWaveMessage('正在生成波形...')
      try {
        // Yield once so the click/UI update paints before the expensive media decode starts.
        await new Promise<void>((resolve) => window.setTimeout(resolve, 80))
        if (cancelled) return
        const response = await fetch(sourceUrl)
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const buffer = await response.arrayBuffer()
        const AudioContextClass = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
        if (!AudioContextClass) throw new Error('Web Audio API is not available')
        audioContext = new AudioContextClass()
        const audioBuffer = await audioContext.decodeAudioData(buffer.slice(0))
        if (cancelled) return
        const channel = audioBuffer.getChannelData(0)
        const pointsPerSec = WAVEFORM_POINTS_PER_SEC
        const windowSize = Math.max(1, Math.floor(audioBuffer.sampleRate / pointsPerSec))
        const peakCount = Math.max(1, Math.ceil(audioBuffer.duration * pointsPerSec))
        const peaks = new Float32Array(peakCount)

        for (let i = 0; i < peakCount; i++) {
          let max = 0
          const start = i * windowSize
          const end = Math.min(channel.length, start + windowSize)
          for (let j = start; j < end; j++) {
            const value = Math.abs(channel[j])
            if (value > max) max = value
          }
          peaks[i] = max
        }

        await audioContext.close?.()
        audioContext = null
        if (cancelled) return
        setWavePeaks(peaks)
        setWaveFailed(false)
        setWaveMessage(`波形已生成：${waveformTarget.name || 'media'}`)
      } catch (error) {
        if (cancelled) return
        setWavePeaks(null)
        setWaveFailed(true)
        setWaveMessage(error instanceof Error ? error.message : 'Waveform unavailable')
      } finally {
        if (audioContext) {
          try { await audioContext.close?.() } catch {}
        }
        if (!cancelled) setWaveLoading(false)
      }
    }

    loadWaveform()
    return () => {
      cancelled = true
    }
  }, [waveRequestId, waveformTarget.name, waveformTarget.url])

  const waveMissingRanges = useMemo(() => {
    if (!wavePeaks || wavePeaks.length === 0) return [] as Array<{ start: number; end: number }>
    const pointsPerSec = WAVEFORM_POINTS_PER_SEC
    const threshold = 0.035
    const minDuration = 0.18
    const mergeGap = 0.2
    const active: Array<{ start: number; end: number }> = []
    let rangeStart: number | null = null

    for (let i = 0; i < wavePeaks.length; i++) {
      const isActive = wavePeaks[i] >= threshold
      const t = i / pointsPerSec
      if (isActive && rangeStart === null) rangeStart = t
      if (!isActive && rangeStart !== null) {
        active.push({ start: rangeStart, end: t })
        rangeStart = null
      }
    }
    if (rangeStart !== null) active.push({ start: rangeStart, end: wavePeaks.length / pointsPerSec })

    const merged = active.reduce<Array<{ start: number; end: number }>>((acc, range) => {
      const last = acc[acc.length - 1]
      if (last && range.start - last.end <= mergeGap) {
        last.end = range.end
      } else {
        acc.push({ ...range })
      }
      return acc
    }, [])

    const overlaps = (range: { start: number; end: number }, item: { start: number; end: number }) => {
      const overlap = Math.max(0, Math.min(range.end, item.end) - Math.max(range.start, item.start))
      const rangeDuration = Math.max(0.001, range.end - range.start)
      return overlap / rangeDuration
    }

    return merged
      .filter((range) => range.end - range.start >= minDuration)
      .filter((range) => !segments.some((segment) => overlaps(range, segment) >= 0.35))
      .filter((range) => !srt?.subtitles.some((subtitle) => overlaps(range, subtitle) >= 0.35))
      .slice(0, 200)
  }, [segments, srt, wavePeaks])
  waveMissingRangesRef.current = waveMissingRanges

  const currentExportIssues = useMemo(() => buildExportIssues({
    segments,
    speakers,
    media,
    rttm,
    rttmKind,
    srt,
    candidateFile,
    selectedEpisodeId,
    waveMissingRanges,
  }), [candidateFile, media, rttm, rttmKind, selectedEpisodeId, segments, speakers, srt, waveMissingRanges])
  const exportReportPrimaryIssue = currentExportIssues.blocking[0] || currentExportIssues.warnings[0] || '导出前检查未发现明显缺口'

  const waveformChunkSeconds = useMemo(() => {
    return Math.max(1, WAVEFORM_MAX_CHUNK_WIDTH / pxPerSec)
  }, [pxPerSec])
  const waveformChunks = useMemo(() => {
    if (!wavePeaks) return [] as Array<{ index: number; start: number; end: number }>
    const totalDuration = Math.max(duration || 0, wavePeaks ? wavePeaks.length / WAVEFORM_POINTS_PER_SEC : 0, 60)
    const count = Math.max(1, Math.ceil(totalDuration / waveformChunkSeconds))
    return Array.from({ length: count }, (_, index) => {
      const start = index * waveformChunkSeconds
      const end = Math.min(totalDuration, start + waveformChunkSeconds)
      return { index, start, end }
    })
  }, [duration, wavePeaks, waveformChunkSeconds])

  // Draw waveform in chunks. A full-episode canvas can exceed browser limits.
  useEffect(()=>{
    if (!wavePeaks || waveformChunks.length === 0) return
    const dpr = (window.devicePixelRatio||1)
    const H = WAVEFORM_HEIGHT
    const waveformAmplitude = Math.max(24, H - WAVEFORM_VERTICAL_PADDING * 2)
    const samples = wavePeaks?.length ?? 0
    let maxPeak = 0
    if (wavePeaks) {
      for (let i = 0; i < samples; i++) {
        if (wavePeaks[i] > maxPeak) maxPeak = wavePeaks[i]
      }
    }
    const scalePeak = Math.max(0.04, maxPeak)

    const drawBackground = (ctx: CanvasRenderingContext2D, W: number) => {
      ctx.fillStyle = '#070b12'
      ctx.fillRect(0,0,W,H)
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.12)'
      ctx.lineWidth = 1
      for (let y = 18; y < H; y += 24) {
        ctx.beginPath()
        ctx.moveTo(0, y)
        ctx.lineTo(W, y)
        ctx.stroke()
      }
      const mid = H/2
      ctx.strokeStyle = 'rgba(125, 211, 252, 0.24)'
      ctx.beginPath()
      ctx.moveTo(0, mid)
      ctx.lineTo(W, mid)
      ctx.stroke()
    }

    waveformChunks.forEach((chunk) => {
      const canvas = waveChunkRefs.current.get(chunk.index)
      if(!canvas) return
      const ctx = canvas.getContext('2d')
      if(!ctx) return
      const W = Math.max(1, Math.ceil((chunk.end - chunk.start) * pxPerSec))
      canvas.width = Math.floor(W * dpr)
      canvas.height = Math.floor(H * dpr)
      canvas.style.width = W + 'px'
      canvas.style.height = H + 'px'
      ctx.setTransform(1,0,0,1,0,0)
      ctx.scale(dpr, dpr)
      ctx.clearRect(0,0,W,H)
      drawBackground(ctx, W)

      if(!wavePeaks || wavePeaks.length===0){
      ctx.strokeStyle = '#233044'
      ctx.beginPath()
      ctx.moveTo(0, H/2)
      ctx.lineTo(W, H/2)
      ctx.stroke()
      return
    }

    const mid = H/2
    const gradient = ctx.createLinearGradient(0, 0, 0, H)
    gradient.addColorStop(0, '#fef08a')
    gradient.addColorStop(0.45, '#38bdf8')
    gradient.addColorStop(0.55, '#38bdf8')
    gradient.addColorStop(1, '#22c55e')
    ctx.strokeStyle = gradient
    ctx.lineWidth = 1.4
    ctx.shadowColor = 'rgba(56, 189, 248, 0.45)'
    ctx.shadowBlur = 7
    ctx.globalAlpha = 0.92
    ctx.beginPath()
    for(let x=0;x<W;x++){
      const t = chunk.start + x / pxPerSec
      const idx = Math.min(samples-1, Math.max(0, Math.floor(t * WAVEFORM_POINTS_PER_SEC)))
      const amp = wavePeaks[idx] || 0
      const normalized = Math.min(1, amp / scalePeak)
      const h = Math.max(1, normalized * waveformAmplitude)
      ctx.moveTo(x, mid - h/2)
      ctx.lineTo(x, mid + h/2)
    }
    ctx.stroke()
    ctx.shadowBlur = 0
    ctx.globalAlpha = 1
    })
  }, [wavePeaks, waveformChunks, pxPerSec])



  useEffect(()=>{
    if(refSegments.length===0 || segments.length===0){ setDerOverlay([]); setMetrics(null); return }
    const { intervals, metrics } = computeDER(refSegments, segments)
    setDerOverlay(intervals)
    setMetrics(metrics)
  }, [refSegments, segments])

  return (
    <div className="app-shell notranslate" translate="no" style={{display:'flex', flexDirection:'column', height:'100%'}}>
      {/* Top status bar */}
      <div className="appbar annotation-topbar">
        <div className="logo compact-logo">
          <a
            className="badge github"
            href="https://github.com/DURUII/rttm-visualizer"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Open GitHub repository"
            title="GitHub"
          >
            <Github size={18} />
          </a>
          <div>
            <div className="title">{title}</div>
            <div className="topbar-subtitle">{modeLabel}</div>
          </div>
        </div>
        {workMode === 'inspect' ? (
          <>
            <div className="mode-switch inspection-mode-switch">
              <button onClick={() => changeWorkMode('prepare')}>准备</button>
              <button onClick={() => changeWorkMode('annotate')} disabled={!isReadyForAnnotation}>标注</button>
              <button className="active" onClick={() => changeWorkMode('inspect')}>检查</button>
            </div>
            <div className="inspection-top-meta">
              <strong>{episodeLabelFromId(selectedEpisodeId)}</strong>
              <label>复核人：<input value={reviewerName} onChange={(event) => setReviewerName(event.target.value)} /></label>
              <label>第 <input type="number" min={1} value={reviewRoundNumber} onChange={(event) => setReviewRoundNumber(Math.max(1, Number(event.target.value) || 1))} /> 轮复核</label>
              <span><b>{reviewSummary.reviewed}</b> / {reviewSummary.total}</span>
            </div>
            <div className="topbar-actions inspection-top-actions">
              <button className="btn tiny" onClick={() => projectInputRef.current?.click()}><Upload className="file-icon" />导入标注工程</button>
              <button className="btn tiny" onClick={() => exportReviewProgress('draft')}><Download className="file-icon" />保存复核进度</button>
              <button className="btn tiny primary-action" onClick={() => exportReviewProgress('submitted')}><Download className="file-icon" />导出复核包</button>
            </div>
          </>
        ) : (
          <>
        <div className="topbar-status">
          <span className="status-chip selected-chip">{episodeLabelFromId(selectedEpisodeId)}</span>
          <span className={`status-chip ${media ? 'ok' : 'blocked'}`}>媒体 {media ? '已加载' : '缺失'}</span>
          <span className={`status-chip ${hasRTTM ? (isInitialRttmPackage ? 'warn' : 'ok') : 'blocked'}`}>{rttmKindLabel} {hasRTTM ? '已加载' : '缺失'}</span>
          <span className={`status-chip ${hasSRT ? 'ok' : 'blocked'}`}>SRT {hasSRT ? '已加载' : '缺失'}</span>
          <span className="status-chip">进度 {reviewProgress.reviewed} / {reviewProgress.total}</span>
          <span className="status-chip warn">当前筛选待处理 {filteredPendingCount}</span>
          <span className="status-chip warn">UNKNOWN {currentExportIssues.summary.unknownSpeaker}</span>
          <span className="status-chip">漏句 {currentExportIssues.summary.inserted}</span>
          <span className="status-chip">删除 {currentExportIssues.summary.deleted}</span>
          <span className={`status-chip ${draftAvailable ? 'ok' : ''}`}>自动草稿 {formatSavedAt(lastDraftSavedAt)}</span>
        </div>
        <div className="topbar-actions">
          <div className="mode-switch">
            <button className={workMode === 'prepare' ? 'active' : ''} onClick={() => changeWorkMode('prepare')}>准备</button>
            <button className={workMode === 'annotate' ? 'active' : ''} onClick={() => changeWorkMode('annotate')} disabled={!isReadyForAnnotation}>标注</button>
            <button onClick={() => changeWorkMode('inspect')}>检查</button>
          </div>
          <button className="btn tiny" onClick={() => projectInputRef.current?.click()}><Upload className="file-icon" />导入工程JSON继续</button>
          <button className="btn tiny" onClick={exportRTTM}><Download className="file-icon" />导出RTTM</button>
          <button className="btn tiny primary-action" onClick={exportJSON}><Download className="file-icon" />保存进度JSON</button>
        </div>
          </>
        )}
      </div>
      <input ref={projectInputRef} type="file" style={{display:'none'}} accept=".json"
        onChange={(event) => {
          if (event.target.files) handleFiles(Array.from(event.target.files), 'project')
          event.currentTarget.value = ''
        }} />

      <div className={`layout${workMode === 'inspect' ? ' inspection-layout' : ''}`}>
        {/* Left panel: resource loading and checks */}
        {workMode !== 'inspect' && (
        <div className={"panel resource-panel section" + (leftCollapsed ? ' collapsed' : '')}
          onDragOver={(e)=>{e.preventDefault(); setDragOver(true)}}
          onDragLeave={()=>setDragOver(false)}
          onDrop={onDrop}
        >
          {leftCollapsed ? (
            <button className="resource-rail-button" onClick={toggleResourcePanel} title="展开资源面板">
              <span>资源</span>
              <small>{requiredLoadedCount}/{requiredTotalCount}</small>
            </button>
          ) : (
            <>
          <div className="section">
            <div className="card source-status-card episode-wizard">
              <div className="wizard-header">
                <div>
                  <div style={{fontWeight:800}}>剧集加载向导</div>
                  <div className="badge-sm">先选集数，再逐项检查文件是否齐全</div>
                </div>
                <div className="episode-selector">
                  <span>标注</span>
                  <select
                    value={selectedEpisodeId}
                    onChange={(event) => {
                      episodeManuallySelectedRef.current = true
                      setSelectedEpisodeId(normalizeEpisodeId(event.target.value))
                    }}
                  >
                    {episodeOptions.map((episodeId) => (
                      <option key={episodeId} value={episodeId}>{episodeLabelFromId(episodeId)}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div className={`wizard-summary ${missingRequiredCount === 0 ? 'ready' : 'blocked'}`}>
                <span>{episodeLabelFromId(selectedEpisodeId)}</span>
                <span>
                  {missingRequiredCount === 0
                    ? '必需文件已齐，可以开始标注'
                    : `还缺 ${missingRequiredCount} 个必需文件`}
                </span>
              </div>
              <div className={`work-package-card ${isInitialRttmPackage ? 'initial' : 'standard'}`}>
                <div className="work-package-title">
                  <span>{episodePackage.label} · {episodePackage.modalityLabel}</span>
                  <strong>{rttmKindLabel}</strong>
                </div>
                <div className="package-asset-grid">
                  <span>媒体 {bundledEpisodeAssets.media}</span>
                  <span>RTTM {bundledEpisodeAssets.rttm}</span>
                  <span>SRT {bundledEpisodeAssets.srt}</span>
                  <span>subseg {bundledEpisodeAssets.subseg}</span>
                </div>
                <p>{packageNotice || episodePackage.note}</p>
              </div>
              <div className="review-progress-card">
                <div className="row" style={{justifyContent:'space-between'}}>
                  <span>标注进度</span>
                  <strong>{reviewProgress.percent}%</strong>
                </div>
                <div className="progress-bar">
                  <span style={{width: `${reviewProgress.percent}%`}} />
                </div>
                <div className="progress-grid">
                  <span>总数 {reviewProgress.total}</span>
                  <span>pending {reviewProgress.counts.pending}</span>
                  <span>checked {reviewProgress.counts.checked}</span>
                  <span>corrected {reviewProgress.counts.corrected}</span>
                  <span>inserted {reviewProgress.counts.inserted}</span>
                  <span>uncertain {reviewProgress.counts.uncertain}</span>
                </div>
                <div className="autosave-line">
                  <span>工程 JSON 草稿：{formatSavedAt(lastDraftSavedAt)}</span>
                  <button
                    className="btn tiny"
                    disabled={!draftAvailable}
                    onClick={restoreCurrentEpisodeDraft}
                  >
                    恢复本集草稿
                  </button>
                </div>
              </div>
              <div className="resume-work-card">
                <div className="resume-work-title">
                  <span>继续上次标注</span>
                  <strong>推荐工程 JSON</strong>
                </div>
                <p className="resume-work-note">
                  长期保存请用导出的工程 JSON；本机草稿只适合同一浏览器临时恢复。恢复工程 JSON 后，仍需重新上传视频/音频用于播放。
                </p>
                <div className="resume-work-actions">
                  <button className="btn tiny primary-action" onClick={() => projectInputRef.current?.click()}>
                    <Upload className="file-icon" />导入工程JSON继续
                  </button>
                  <button className="btn tiny" disabled={!draftAvailable} onClick={restoreCurrentEpisodeDraft}>
                    恢复本机草稿
                  </button>
                  <button className="btn tiny" onClick={exportJSON}>
                    <Download className="file-icon" />保存当前进度
                  </button>
                </div>
              </div>
              <div className={`export-report-card ${currentExportIssues.blocking.length > 0 ? 'blocked' : currentExportIssues.warnings.length > 0 ? 'warn' : 'ready'}`}>
                <div className="work-package-title">
                  <span>导出前检查</span>
                  <strong>{currentExportIssues.blocking.length > 0 ? '需处理' : currentExportIssues.warnings.length > 0 ? '有提醒' : '可导出'}</strong>
                </div>
                <div className="export-report-grid">
                  <span>pending {currentExportIssues.summary.pending}</span>
                  <span>UNKNOWN {currentExportIssues.summary.unknownSpeaker}</span>
                  <span>漏句 {currentExportIssues.summary.inserted}</span>
                  <span>删除 {currentExportIssues.summary.deleted}</span>
                  <span>空漏句 {currentExportIssues.summary.emptyInserted}</span>
                  <span>疑似波峰 {currentExportIssues.summary.suspectedMissingRanges}</span>
                </div>
                <p>{exportReportPrimaryIssue}</p>
              </div>
              {currentEpisodeLabel !== '未识别' && currentEpisodeLabel !== episodeLabelFromId(selectedEpisodeId) && (
                <div className="wizard-warning">
                  当前已加载文件更像 {currentEpisodeLabel}，但你选择的是 {episodeLabelFromId(selectedEpisodeId)}。如果要标注新剧集，请重新上传对应文件。
                </div>
              )}
              <div className="source-file-list">
                {episodeRequirementRows.map((row) => (
                  <div key={row.key} className={`source-file-row wizard-file ${row.state}`}>
                    <span className="source-file-dot" />
                    <div className="source-file-main">
                      <div className="source-file-title">
                        <span>{row.label}</span>
                        <span className={`wizard-tag ${row.required ? 'required' : 'optional'}`}>
                          {row.required ? '必需' : '可选'}
                        </span>
                      </div>
                      <div className="source-file-name" title={row.name || row.detail}>{row.name || row.detail}</div>
                    </div>
                    <button className="btn tiny" onClick={row.action}>
                      {row.name ? '替换' : '上传'}
                    </button>
                  </div>
                ))}
              </div>
              <input ref={mediaInputRef} type="file" style={{display:'none'}} accept=".mp4,.webm,.mp3,.wav,.m4a"
                onChange={e=> e.target.files && handleFiles(Array.from(e.target.files))} />
              <input ref={rttmInputRef} type="file" style={{display:'none'}} accept=".rttm"
                onChange={e=> e.target.files && handleFiles(Array.from(e.target.files), 'sys')} />
              <input ref={refRttmInputRef} type="file" style={{display:'none'}} accept=".rttm"
                onChange={e=> e.target.files && handleFiles(Array.from(e.target.files), 'ref')} />
              <input ref={srtInputRef} type="file" style={{display:'none'}} accept=".srt"
                onChange={e=> e.target.files && handleFiles(Array.from(e.target.files))} />
              <input ref={candidateInputRef} type="file" style={{display:'none'}} accept=".json"
                onChange={(event) => {
                  if (event.target.files) handleFiles(Array.from(event.target.files), 'candidate')
                  event.currentTarget.value = ''
                }} />
            </div>
          </div>

          <div className="section">
            <div className="card">
              <div className="row" style={{justifyContent:'space-between', marginBottom:8}}>
                <div style={{fontWeight:700}}>Waveform Check</div>
                <div className="row">
                  <span className="badge-sm">{waveMissingRanges.length} gaps</span>
                  <button className="btn tiny" onClick={requestWaveformGeneration} disabled={waveLoading || !waveformTarget.url}>
                    {waveLoading ? '生成中' : wavePeaks ? '重新生成' : '生成波形'}
                  </button>
                </div>
              </div>
              <div className="badge-sm" style={{marginBottom:8}}>
                {waveLoading ? 'Analyzing waveform...' : waveMessage || 'Waveform waits for media'}
              </div>
              {waveMissingRanges.length === 0 ? (
                <div className="badge-sm">No suspected missing speech yet.</div>
              ) : (
                <div className="missing-list">
                  {waveMissingRanges.slice(0, 10).map((range, index) => (
                    <div className="missing-item" key={`${range.start}-${range.end}`}>
                      <button className="missing-time" onClick={() => seek(range.start)}>
                        {index + 1}. {formatHMSms(range.start)} - {formatHMSms(range.end)}
                      </button>
                      <button className="btn tiny" onClick={() => insertMissingRange(range)}>插入</button>
                    </div>
                  ))}
                  {waveMissingRanges.length > 10 && (
                    <div className="badge-sm">Only first 10 shown; zoom the timeline for details.</div>
                  )}
                </div>
              )}
            </div>
          </div>
            </>
          )}
        </div>
        )}

        {/* Center content: video + controls + timeline (resizable video area, scrollable tracks) */}
        <div className="center" ref={centerRef}>
          {/* Video area */}
          <div className="section" style={{paddingBottom: 0}}>
            <div style={{height: videoAreaHeight}}>
              {media?.type === 'video' ? (
                <video ref={videoRef} src={media.url} onTimeUpdate={onTimeUpdate} onLoadedMetadata={onLoadedMetadata}
                  style={{width:'100%', height:'100%', objectFit:'contain'}} onClick={togglePlay} controls={false} />
              ) : (
                <audio ref={videoRef} src={media?.url} onTimeUpdate={onTimeUpdate} onLoadedMetadata={onLoadedMetadata} controls={false} />
              )}
            </div>
          </div>
          {/* Resizer between video and the rest */}
          <div className="resizer" onMouseDown={onResizeMouseDown} />
          {/* Controls bar (fixed height) */}
          <div className="controls-bar">
            <button className="btn icon" title="Previous segment" onClick={jumpPrev}><SkipBack size={16}/></button>
            <button className="btn icon" title="Play/Pause" onClick={togglePlay}>{isPlaying? <Pause size={16}/> : <Play size={16}/>}</button>
            <button className="btn icon" title="Next segment" onClick={jumpNext}><SkipForward size={16}/></button>
            <div className="space" />
            {/* 添加播放速率控制 */}
            <select 
              value={playbackRate} 
              onChange={(e) => setPlaybackRate(parseFloat(e.target.value))}
              style={{ margin: '0 10px', padding: '4px', borderRadius: '4px', border: '1px solid #4b5563', background: '#1f2937', color: 'white' }}
            >
              <option value={0.25}>0.25x</option>
              <option value={0.5}>0.5x</option>
              <option value={0.75}>0.75x</option>
              <option value={1}>1x</option>
              <option value={1.25}>1.25x</option>
              <option value={1.5}>1.5x</option>
              <option value={2}>2x</option>
              <option value={3}>3x</option>
            </select>
            <button className="btn icon" title="Zoom Out" onClick={zoomOut}><ZoomOut size={16}/></button>
            <input type="range" min={0.25} max={10} step={0.05} value={zoom} onChange={e=>setZoom(+e.target.value)} />
            <button className="btn icon" title="Zoom In" onClick={zoomIn}><ZoomIn size={16}/></button>
            <div style={{width:64, textAlign:'right'}} className="badge-sm">{zoom.toFixed(2)}x</div>
          </div>

          {/* Timeline area with dynamic height */}
          <div className="timeline-wrap" style={{flex: '1 1 auto', minHeight: '200px', display:'flex', flexDirection:'column', padding: '0 12px'}}>
            <div className={`timeline${missingPickMode !== 'idle' ? ' picking-time' : ''}`} style={{flex: '0 0 auto', height: timelineContentHeight}} ref={waveRef} onClick={onClickTimeline}
              onScroll={onTimelineScroll}
              onPointerDown={onTimelinePointerDown}
              onPointerMove={onTimelinePointerMove}
              onPointerUp={onTimelinePointerUp}
              onPointerCancel={onTimelinePointerUp}
              onPointerLeave={onTimelinePointerLeave}
            >
              {/* RULER */}
              <div className="ruler" style={{width: '100%', minWidth: timelineWidth}}>
                {visibleMajorTicks.map((tick)=>{
                  const time = tick.time
                  const left = tick.left
                  const major = tick.major
                  // 避免最后一个标签挤出边界
                  const isLastLabel = time >= (duration||0) - timeDivision * 0.5
                  return (
                    <div key={`major-${time}`}>
                      <div className="tick" style={{left, height: '100%', opacity: 1}}></div>
                      {tick.showLabel && <div className="label" style={{left}}>{formatHMSms(time)}</div>}
                    </div>
                  )
                })}
                {/* 最后时间标签，右对齐 */}
                {duration && duration > 0 && (
                  <div className="label" style={{right: 0, transform: 'translateX(0)'}}>{formatHMSms(duration)}</div>
                )}
                {visibleMinorTicks.map((tick) => (
                  <div key={`minor-${tick.time}`} className="tick" style={{left: tick.left, height: '40%', opacity: 0.4}}></div>
                ))}
              </div>
              {/* Full-height playhead spanning ruler and tracks */}
              <div className="playhead" style={{left: `${currentTime * pxPerSec}px`}} />
              {missingRangePreview && (
                <div
                  className="missing-range-preview"
                  style={{
                    left: `${Math.min(missingRangePreview.start, missingRangePreview.end) * pxPerSec}px`,
                    width: `${Math.max(2, Math.abs(missingRangePreview.end - missingRangePreview.start) * pxPerSec)}px`,
                  }}
                />
              )}
              {timeProbe && (
                <div className="time-probe" style={{left: `${timeProbe.time * pxPerSec}px`}}>
                  <div className="time-probe-label">
                    <strong>{formatHMSms(timeProbe.time)}</strong>
                    <span>{timeProbe.time >= currentTime ? '+' : ''}{(timeProbe.time - currentTime).toFixed(2)}s</span>
                    {timeProbe.speakerName && <span>{timeProbe.speakerName}</span>}
                  </div>
                </div>
              )}

              {/* Waveform */}
              <div className="wave" style={{width: '100%', minWidth: timelineWidth}}>
                {wavePeaks ? (
                  waveformChunks.map((chunk) => (
                    <canvas
                      key={chunk.index}
                      className="wave-chunk"
                      ref={(node) => {
                        if (node) waveChunkRefs.current.set(chunk.index, node)
                        else waveChunkRefs.current.delete(chunk.index)
                      }}
                      style={{
                        left: chunk.start * pxPerSec,
                        width: Math.max(1, (chunk.end - chunk.start) * pxPerSec),
                      }}
                    />
                  ))
                ) : (
                  <div className="wave-placeholder" style={{width: timelineWidth}} />
                )}
                <div className={`wave-status-chip ${waveFailed ? 'failed' : wavePeaks ? 'ready' : ''}`}>
                  {waveLoading ? '正在生成波形...' : waveFailed ? `波形不可用：${waveMessage}` : wavePeaks ? (waveMessage || '波形已加载') : '等待音频生成波形'}
                </div>
                {waveMissingRanges.map((range) => (
                  <button
                    key={`${range.start}-${range.end}`}
                    className="wave-gap"
                    title={`Suspected missing speech ${formatHMSms(range.start)} - ${formatHMSms(range.end)}`}
                    style={{
                      left: range.start * pxPerSec,
                      width: Math.max(2, (range.end - range.start) * pxPerSec),
                    }}
                    onClick={(event) => {
                      event.stopPropagation()
                      seek(range.start)
                    }}
                    onPointerDown={(event) => event.stopPropagation()}
                  />
                ))}
                {workMode === 'inspect' && reviewIssueMarkers.map((marker) => (
                  <button
                    key={marker.id}
                    type="button"
                    className={`review-issue-marker marker-${marker.status}`}
                    style={{ left: marker.time * pxPerSec }}
                    title={marker.label}
                    onClick={(event) => {
                      event.stopPropagation()
                      setSelectedSegId(marker.id)
                      seek(marker.time)
                    }}
                    onPointerDown={(event) => event.stopPropagation()}
                  >!</button>
                ))}
                {(waveFailed || waveLoading) && (
                  <div className="badge-sm" style={{position:'absolute', inset:0, display:'flex', alignItems:'center', justifyContent:'center'}}>
                    {waveLoading ? 'Analyzing waveform...' : `Waveform unavailable: ${waveMessage}`}
                  </div>
                )}
              </div>

              {hasSRT && (
                <div className="subtitle-track" style={{width: '100%', minWidth: timelineWidth}}>
                  <div className="subtitle-track-label">SRT</div>
                  {allSubtitles.map((sub, index) => {
                    const left = sub.start * pxPerSec
                    const width = Math.max(18, (sub.end - sub.start) * pxPerSec)
                    const isCurrent = currentSubtitle?.id === sub.id
                    return (
                      <button
                        key={sub.id}
                        className={`subtitle-chip${isCurrent ? ' active' : ''}`}
                        style={{left, width}}
                        title={`${formatHMSms(sub.start)} - ${formatHMSms(sub.end)} ${sub.text}`}
                        onClick={(event) => {
                          event.stopPropagation()
                          seek(sub.start)
                        }}
                        onPointerDown={(event) => event.stopPropagation()}
                      >
                        <span className="subtitle-chip-index">{index + 1}</span>
                        <span className="subtitle-chip-text">{sub.text}</span>
                      </button>
                    )
                  })}
                </div>
              )}

              {/* Tracks container fills remaining height */}
              {/* Tracks container fills remaining height */}
              <div className="tracks" style={{ 
                width: '100%', 
                minWidth: timelineWidth, 
                flex: '0 0 auto',
                height: speakerTrackViewportHeight,
                display: 'flex', 
                flexDirection: 'column',
                position: 'relative' // 用于 DER overlay 定位
              }}>
                {/* 可滚动的轨道容器 */}
                <div
                  ref={speakerTracksViewportRef}
                  style={{
                    flex: 'none',
                    height: '100%',
                    overflowY: 'auto',
                    paddingRight: '8px',
                  }}
                >
                  {allTracks.map(spk => {
                    const hidden = speakers.length > 0 ? !spk.visible : false
                    const trackSegments = speakers.length > 0 ? (segmentsBySpeaker.get(spk.id) ?? []) : []
                    const isSelectedTrack = selectedSegment?.speakerId === spk.id
                    return (
                      <div
                        key={spk.id}
                        ref={(node) => {
                          if (node) trackRefs.current.set(spk.id, node)
                          else trackRefs.current.delete(spk.id)
                        }}
                        className={`track${isSelectedTrack ? ' selected-track' : ''}`}
                        title={spk.name} // 👈 悬停显示说话人名
                        style={{
                          width: '100%',
                          minWidth: timelineWidth,
                          height: SPEAKER_TRACK_HEIGHT,
                          background: '#121624',
                          border: '1px solid #20263a',
                          borderTop: 'none',
                          opacity: hidden ? 0.3 : 1,
                          boxSizing: 'border-box',
                          cursor: 'default'
                        }}
                        onMouseMove={(e) => {
                          if (speakers.length === 0) return
                          if ((e.target as HTMLElement).closest('.seg')) return
                          const t = toTimeFromClientX(e.clientX)
                          const dur = 0.2
                          const start = Math.max(0, Math.min((duration || 0) - dur, t - dur / 2))
                          const end = Math.min(duration || start + dur, start + dur)
                          scheduleGhostSeg({ speakerId: spk.id, start, end })
                        }}
                        onMouseLeave={() => setGhostSegNow(null)}
                        onClick={(e) => {
                          if ((e.target as HTMLElement).closest('.seg')) return
                          if (speakers.length === 0) return
                          const t = toTimeFromClientX(e.clientX)
                          const dur = 0.2
                          const start = Math.max(0, Math.min((duration || 0) - dur, t - dur / 2))
                          const newId = createSegmentAt(spk.id, start)
                          setSelectedSegId(newId)
                        }}
                      >
                        {ghostSeg && ghostSeg.speakerId === spk.id && (
                          <div
                            className="seg ghost"
                            style={{
                              left: ghostSeg.start * pxPerSec,
                              width: (ghostSeg.end - ghostSeg.start) * pxPerSec
                            }}
                          />
                        )}
                        {speakers.length > 0 ? (
                          <>
                            {trackSegments.length === 0 && (
                              <div className="empty-track-hint">
                                <span style={{ background: spk.color }} />
                                点击此轨道插入 {spk.name} 的片段
                              </div>
                            )}
                            {trackSegments.map(seg => {
                            const left = seg.start * pxPerSec
                            const w = (seg.end - seg.start) * pxPerSec
                            const isActive = currentTime >= seg.start && currentTime < seg.end
                            const status = seg.reviewStatus || 'pending'
                            return (
                              <div
                                key={seg.id}
                                className={`seg status-${status}${isActive ? ' active' : ''}${selectedSegId === seg.id ? ' selected' : ''}`}
                                style={{ left, width: Math.max(status === 'inserted' ? 10 : 2, w), background: spk.color }}
                                onMouseEnter={(e) => {
                                  setTooltip({
                                    x: e.clientX,
                                    y: e.clientY - 30,
                                    text: `${spk.name}  ${formatHMSms(seg.start)}–${formatHMSms(seg.end)} (${formatHMSms(seg.end - seg.start)})`
                                  })
                                }}
                                onMouseLeave={() => setTooltip(null)}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setSelectedSegId(seg.id);
                                  seek(seg.start);
                                }}
                                onContextMenu={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  setSelectedSegId(seg.id);
                                  setCtxMenu({ x: e.clientX, y: e.clientY, segId: seg.id });
                                }}
                              >
                                <div
                                  className="handle left"
                                  onPointerDown={(e) => {
                                    e.stopPropagation();
                                    dragRef.current = { type: 'start', speakerId: spk.id, segId: seg.id };
                                    try { (e.target as Element).setPointerCapture?.(e.pointerId) } catch {}
                                    const onMove = (ev: PointerEvent) => {
                                      const t = toTimeFromClientX(ev.clientX);
                                      setDragTip({ x: ev.clientX, y: ev.clientY - 28, text: `${formatHMSms(t)} →` });
                                      updateSegmentTime(seg.id, Math.min(t, seg.end - MIN_DUR), seg.end);
                                    };
                                    const onUp = (ev: PointerEvent) => {
                                      try { (e.target as Element).releasePointerCapture?.((ev as any).pointerId) } catch {}
                                      dragRef.current = null; setDragTip(null);
                                      window.removeEventListener('pointermove', onMove);
                                      window.removeEventListener('pointerup', onUp);
                                    };
                                    window.addEventListener('pointermove', onMove);
                                    window.addEventListener('pointerup', onUp);
                                  }}
                                />
                                <div
                                  className="handle right"
                                  onPointerDown={(e) => {
                                    e.stopPropagation();
                                    dragRef.current = { type: 'end', speakerId: spk.id, segId: seg.id };
                                    try { (e.target as Element).setPointerCapture?.(e.pointerId) } catch {}
                                    const onMove = (ev: PointerEvent) => {
                                      const t = toTimeFromClientX(ev.clientX);
                                      setDragTip({ x: ev.clientX, y: ev.clientY - 28, text: `← ${formatHMSms(t)}` });
                                      updateSegmentTime(seg.id, seg.start, Math.max(t, seg.start + MIN_DUR));
                                    };
                                    const onUp = (ev: PointerEvent) => {
                                      try { (e.target as Element).releasePointerCapture?.((ev as any).pointerId) } catch {}
                                      dragRef.current = null; setDragTip(null);
                                      window.removeEventListener('pointermove', onMove);
                                      window.removeEventListener('pointerup', onUp);
                                    };
                                    window.addEventListener('pointermove', onMove);
                                    window.addEventListener('pointerup', onUp);
                                  }}
                                />
                              </div>
                            );
                            })}
                          </>
                        ) :
                          <div style={{
                            position: 'absolute',
                            left: '10px',
                            top: '50%',
                            transform: 'translateY(-50%)',
                            color: '#6B7280',
                            fontSize: '12px'
                          }}>
                            Empty track
                          </div>
                        }
                      </div>
                    );
                  })}

                  {/* Reference track overlay (locked, gray) */}
                  {showRefTrack && refSegments.length > 0 && (
                    <div
                      className="track"
                      style={{
                        width: '100%',
                        minWidth: timelineWidth,
                        height: SPEAKER_TRACK_HEIGHT,
                        background: '#0f121b',
                        border: '1px solid #20263a',
                        borderTop: 'none',
                        boxSizing: 'border-box'
                      }}
                    >
                      {refSegments.map(seg => {
                        const left = seg.start * pxPerSec
                        const w = (seg.end - seg.start) * pxPerSec
                        return (
                          <div
                            key={'ref-' + seg.id}
                            className={'seg'}
                            style={{ left, width: w, background: '#6b7280', opacity: 0.5 }}
                            onMouseEnter={(e) => {
                              setTooltip({
                                x: e.clientX,
                                y: e.clientY - 30,
                                text: `REF ${seg.speakerId}  ${formatHMSms(seg.start)}–${formatHMSms(seg.end)}`
                              });
                            }}
                            onMouseLeave={() => setTooltip(null)}
                          />
                        );
                      })}
                      <div className="badge-sm" style={{ position: 'absolute', left: 6, top: 6, color: '#cbd5e1' }}>Reference</div>
                    </div>
                  )}
                </div>

                {/* DER overlay (覆盖整个 tracks 区域) */}
                {showDER && derOverlay.length > 0 && (
                  <div
                    className="der-overlay"
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      right: 0,
                      bottom: 0,
                      pointerEvents: 'none'
                    }}
                  >
                    {derOverlay.map((iv, idx) => {
                      if (iv.type === 'OK') return null;
                      const left = iv.start * pxPerSec;
                      const w = Math.max(1, (iv.end - iv.start) * pxPerSec);
                      const color = iv.type === 'MS' ? '#60a5fa' : iv.type === 'FA' ? '#ef4444' : '#f59e0b';
                      return (
                        <div
                          key={idx}
                          className={`der-chunk ${iv.type.toLowerCase()}`}
                          style={{
                            position: 'absolute',
                            left,
                            width: w,
                            top: 0,
                            bottom: 0,
                            background: color,
                            opacity: 0.18
                          }}
                          onMouseEnter={(e) =>
                            setTooltip({
                              x: e.clientX,
                              y: e.clientY - 30,
                              text: `${iv.type}  ${formatHMSms(iv.start)}–${formatHMSms(iv.end)} (${formatHMSms(iv.end - iv.start)})`
                            })
                          }
                          onMouseLeave={() => setTooltip(null)}
                        />
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
            {tooltip && (
              <div style={{position:'fixed', left: tooltip.x, top: tooltip.y, background:'#111827', border:'1px solid #374151', padding:'6px 8px', borderRadius:6, fontSize:12, pointerEvents:'none'}}>
                {tooltip.text}
              </div>
            )}
            {dragTip && (
              <div style={{position:'fixed', left: dragTip.x, top: dragTip.y, background:'#0b1220', border:'1px solid #2a3040', padding:'6px 8px', borderRadius:6, fontSize:12, pointerEvents:'none'}}>
                {dragTip.text}
              </div>
            )}
            {ctxMenu && (
              <div className="context-menu" style={{left: ctxMenu.x, top: ctxMenu.y}} onClick={(e)=> e.stopPropagation()}>
                <button className="menu-item" onClick={()=>{ setConfirmDelete({open:true, segId: ctxMenu.segId}); setCtxMenu(null) }}>删除</button>
                <button className="menu-item" onClick={()=> setCtxMenu(null)}>取消</button>
              </div>
            )}
          </div>
        </div>

        {/* Right panel: current segment review + full dialogue list */}
        <div className={"panel right section" + (rightCollapsed ? ' collapsed' : '') + (workMode === 'inspect' ? ' inspection-panel' : '')}>
          {workMode === 'inspect' ? (
            <ReviewWorkbench
              segments={reviewDisplaySegments}
              speakers={speakers.map((speaker) => ({ id: speaker.id, name: speaker.name }))}
              selectedSegmentId={selectedSegId}
              currentTime={currentTime}
              workspace={effectiveReviewWorkspace}
              onSelectSegment={(segment) => {
                setSelectedSegId(segment.id)
                seek(segment.start)
              }}
              onReviewAction={handleReviewAction}
            />
          ) : !rightCollapsed && (
            <div className="right-workbench">
              <div className="card fade-in inspector-card current-segment-card">
                <div className="row inspector-title-row">
                  <div>
                    <div style={{fontWeight:800}}>时间与文本精细校对</div>
                    <div className="badge-sm">开始时间、结束时间和台词始终可编辑；高频操作集中在上方台词列表。</div>
                  </div>
                </div>
                {!selectedSegment ? (
                  <div className="empty-inspector">点击时间轴中的说话片段，或点击波峰疑似漏句区域开始校对。</div>
                ) : (
                  <>
                    <div className="selected-summary">
                      <span>{formatHMSms(selectedSegment.start)} - {formatHMSms(selectedSegment.end)}</span>
                      <span>{selectedSpeaker?.name || selectedSegment.speakerId}</span>
                      <span className={`status-pill status-${selectedSegment.reviewStatus || 'pending'}`}>
                        {selectedSegment.reviewStatus || 'pending'}
                      </span>
                    </div>
                    {selectedRevisionSummary && selectedRevisionSummary.badges.length > 0 && (
                      <div className="revision-summary">
                        <div className="revision-badges">
                          {selectedRevisionSummary.badges.map((badge) => (
                            <span key={badge}>{badge}</span>
                          ))}
                        </div>
                        {selectedRevisionSummary.speakerLine && (
                          <div>原说话人：{selectedRevisionSummary.speakerLine}</div>
                        )}
                        {selectedRevisionSummary.textLine && (
                          <div>原台词：{selectedRevisionSummary.textLine}</div>
                        )}
                      </div>
                    )}
                    {selectedReviewEvent && ['issue_reported', 'change_proposed', 'reopened'].includes(selectedReviewEvent.action) && (
                      <section className="review-feedback-card">
                        <div className="review-feedback-heading">
                          <div>
                            <strong>检查人反馈</strong>
                            <span>{selectedReviewEvent.actor.name} · {new Date(selectedReviewEvent.created_at).toLocaleString('zh-CN', { hour12: false })}</span>
                          </div>
                          <span className="review-feedback-status">待回改</span>
                        </div>
                        <p>{selectedReviewEvent.reason || '检查人未填写具体原因'}</p>
                        <div className="review-feedback-compare">
                          <div><small>检查前</small><b>{selectedReviewEvent.before.speaker_name}</b><span>{selectedReviewEvent.before.text || '（空台词）'}</span></div>
                          <span>→</span>
                          <div><small>检查建议</small><b>{selectedReviewEvent.proposed_after?.speaker_name || '未提出新值'}</b><span>{selectedReviewEvent.proposed_after?.text || '未提出文本修改'}</span></div>
                        </div>
                        <div className="review-feedback-actions">
                          <button
                            type="button"
                            className="btn tiny primary-action"
                            disabled={!selectedReviewEvent.proposed_after}
                            onClick={() => respondToReviewSuggestion(true)}
                          >接受建议并回改</button>
                          <button type="button" className="btn tiny" onClick={() => respondToReviewSuggestion(false)}>保留当前值并回复</button>
                        </div>
                      </section>
                    )}
                    <div className="editor-grid">
                      <label className="field">
                        <span>开始秒</span>
                        <input
                          type="number"
                          min={0}
                          step={0.01}
                          value={selectedSegment.start.toFixed(3)}
                          onChange={(event) => updateSelectedSegment({ start: Math.max(0, Number(event.target.value) || 0) })}
                        />
                      </label>
                      <label className="field">
                        <span>结束秒</span>
                        <input
                          type="number"
                          min={0}
                          step={0.01}
                          value={selectedSegment.end.toFixed(3)}
                          onChange={(event) => updateSelectedSegment({ end: Math.max(selectedSegment.start + MIN_DUR, Number(event.target.value) || selectedSegment.end) })}
                        />
                      </label>
                      <label className="field wide">
                        <span>台词文本（只有文本错/漏时才需要手动输入）</span>
                        <textarea
                          rows={3}
                          value={segmentTextDraft}
                          onChange={(event) => scheduleSegmentTextCommit(event.target.value)}
                          onBlur={flushPendingSegmentText}
                          placeholder="输入或修正这一句台词"
                        />
                      </label>
                    </div>
                    <details className="more-actions">
                      <summary>更多操作：候选证据 / 原始值恢复 / 备注</summary>
                      <div className="candidate-panel">
                        <div className="candidate-header">
                          <span>候选匹配 JSON</span>
                          <span className="badge-sm">{candidateFile?.name || '未加载 subseg_match_results.json'}</span>
                        </div>
                        {!candidateFile ? (
                          <div className="badge-sm">加载候选 JSON 后，这里会显示 top_5_speakers / top_5_faces。</div>
                        ) : !selectedCandidate ? (
                          <div className="badge-sm">当前片段附近没有匹配到候选结果。</div>
                        ) : (
                          <>
                            <div className="candidate-line">
                              <span>{selectedCandidate.segmentKey}</span>
                              <span>{selectedCandidate.start !== undefined ? formatHMSms(selectedCandidate.start) : '--'} - {selectedCandidate.end !== undefined ? formatHMSms(selectedCandidate.end) : '--'}</span>
                            </div>
                            {selectedCandidate.subtitleText && (
                              <div className="candidate-text">{selectedCandidate.subtitleText}</div>
                            )}
                            <div className="candidate-pills">
                              {selectedCandidate.top5Speakers.slice(0, 5).map((candidate, index) => {
                                const role = candidate.role || candidate.speaker || `候选${index + 1}`
                                return (
                                  <button
                                    key={`${role}-${index}`}
                                    className="candidate-pill"
                                    onClick={() => {
                                      const existing = speakers.find((speaker) => speaker.id === role || speaker.name === role)
                                      const speaker = existing || addSpeaker(role, 'candidate')
                                      updateSelectedSegment({
                                        speakerId: speaker.id,
                                        reviewStatus: selectedSegment.reviewStatus === 'pending' ? 'corrected' : selectedSegment.reviewStatus,
                                        evidence: {
                                          fusion: {
                                            role: speaker.name,
                                            strategy: 'candidate_top5_speaker',
                                            confidence: candidate.score,
                                          },
                                        },
                                      })
                                    }}
                                    title="点击后应用为当前片段说话人"
                                  >
                                    {role}{candidate.score !== undefined ? ` ${candidate.score.toFixed(3)}` : ''}
                                  </button>
                                )
                              })}
                              {selectedCandidate.top5Speakers.length === 0 && <span className="badge-sm">top_5_speakers 为空</span>}
                            </div>
                            <div className="badge-sm">top_5_faces: {selectedCandidate.top5Faces.length || '空'}</div>
                          </>
                        )}
                      </div>
                      {selectedRevisionSummary && selectedRevisionSummary.badges.length > 0 && (
                        <div className="restore-original-panel">
                          <div className="quick-panel-title">原始值复核</div>
                          <div className="badge-sm">用于复核误改；只在当前片段存在修改痕迹时显示。</div>
                          <div className="row" style={{gap:8, flexWrap:'wrap'}}>
                            {selectedRevisionSummary.hasSpeakerChanged && selectedSegment.originalSpeakerId && (
                              <button
                                className="btn tiny"
                                onClick={() => updateSelectedSegment({
                                  speakerId: selectedSegment.originalSpeakerId,
                                  evidence: { fusion: { role: selectedSegment.originalSpeakerId, strategy: 'restore_original_speaker' } },
                                })}
                              >
                                恢复原说话人
                              </button>
                            )}
                            {selectedRevisionSummary.hasTextChanged && selectedSegment.originalText !== undefined && (
                              <button
                                className="btn tiny"
                                onClick={() => {
                                  setSegmentTextDraft(selectedSegment.originalText || '')
                                  commitSegmentTextToSegment(selectedSegment.id, selectedSegment.originalText || '')
                                }}
                              >
                                恢复原台词
                              </button>
                            )}
                          </div>
                        </div>
                      )}
                      <label className="field">
                        <span>备注</span>
                        <textarea
                          rows={2}
                          value={segmentNotesDraft}
                          onChange={(event) => scheduleSegmentNotesCommit(event.target.value)}
                          onBlur={flushPendingSegmentNotes}
                          placeholder="记录证据、疑问或修改原因"
                        />
                      </label>
                    </details>
                  </>
                )}
              </div>

              <section className={`card fade-in right-missing-insert-panel${missingInsertOpen ? ' open' : ''}`}>
                <button
                  type="button"
                  className="right-missing-insert-toggle"
                  onClick={() => setMissingInsertOpen((open) => !open)}
                  aria-expanded={missingInsertOpen}
                  aria-controls="right-missing-insert-content"
                >
                  <span className="right-missing-insert-title"><Plus size={15} />插入漏句</span>
                  <span className="right-missing-insert-summary">
                    {missingInsertDraft.start && missingInsertDraft.end
                      ? `${missingInsertDraft.start}s - ${missingInsertDraft.end}s`
                      : '框选波形或手动填写时间'}
                  </span>
                  <span className="right-missing-insert-action">{missingInsertOpen ? '收起' : '展开'}</span>
                </button>
                {missingInsertOpen && (
                  <div id="right-missing-insert-content" className="missing-insert-card quick-missing-card">
                    <div className="quick-panel-title">漏句插入向导</div>
                    <div className="missing-pick-toolbar">
                      <button
                        className={`btn tiny${missingPickMode === 'start' ? ' active' : ''}`}
                        onClick={() => setMissingPickMode((mode) => mode === 'start' ? 'idle' : 'start')}
                      >
                        取开始点
                      </button>
                      <button
                        className={`btn tiny${missingPickMode === 'end' ? ' active' : ''}`}
                        onClick={() => setMissingPickMode((mode) => mode === 'end' ? 'idle' : 'end')}
                      >
                        取结束点
                      </button>
                      <button
                        className={`btn tiny${missingPickMode === 'range' ? ' active' : ''}`}
                        onClick={() => setMissingPickMode((mode) => mode === 'range' ? 'idle' : 'range')}
                      >
                        框选漏句
                      </button>
                      {missingPickMode !== 'idle' && (
                        <button
                          className="btn tiny"
                          onClick={() => {
                            setMissingPickMode('idle')
                            setMissingRangePreviewNow(null)
                            missingRangeAnchorRef.current = null
                          }}
                        >
                          取消取点
                        </button>
                      )}
                    </div>
                    <div className="missing-pick-hint">
                      {missingPickMode === 'start' && '请点击左侧波形/时间轴，自动填入漏句开始秒。'}
                      {missingPickMode === 'end' && '请点击左侧波形/时间轴，自动填入漏句结束秒。'}
                      {missingPickMode === 'range' && '请在左侧波形/时间轴拖拽一段范围，自动填入开始秒和结束秒。'}
                      {missingPickMode === 'idle' && '需要补漏句时，可先框选波形再点“插入漏句”；插入后会立刻进入时间轴、右侧列表、工程草稿和导出结果。'}
                    </div>
                    <div className="missing-insert-grid">
                      <label className="field">
                        <span>开始秒</span>
                        <input
                          type="number"
                          min={0}
                          step={0.01}
                          value={missingInsertDraft.start}
                          onChange={(event) => setMissingInsertDraft((prev) => ({ ...prev, start: event.target.value }))}
                          placeholder="8.47"
                        />
                      </label>
                      <label className="field">
                        <span>结束秒</span>
                        <input
                          type="number"
                          min={0}
                          step={0.01}
                          value={missingInsertDraft.end}
                          onChange={(event) => setMissingInsertDraft((prev) => ({ ...prev, end: event.target.value }))}
                          placeholder="8.57"
                        />
                      </label>
                      <label className="field">
                        <span>说话人</span>
                        <select
                          value={missingInsertDraft.speakerId || selectedSegment?.speakerId || speakers[0]?.id || 'UNKNOWN'}
                          onChange={(event) => setMissingInsertDraft((prev) => ({ ...prev, speakerId: event.target.value }))}
                        >
                          {speakers.length === 0 && <option value="UNKNOWN">UNKNOWN</option>}
                          {speakers.map((speaker) => (
                            <option key={speaker.id} value={speaker.id}>{speaker.name}</option>
                          ))}
                        </select>
                      </label>
                      <label className="field">
                        <span>台词</span>
                        <input
                          value={missingInsertDraft.text}
                          onChange={(event) => setMissingInsertDraft((prev) => ({ ...prev, text: event.target.value }))}
                          placeholder="可先留空，稍后补"
                        />
                      </label>
                    </div>
                    <div className="row missing-insert-footer">
                      <span className="badge-sm">插入后先进入当前工程状态；需导出 RTTM / 工程 JSON 才会保存到文件</span>
                      <button className="btn tiny pass-btn" onClick={insertMissingDraft}>插入漏句</button>
                    </div>
                  </div>
                )}
              </section>

              <div className="right-scroll">
                {segments.length > 0 && (
                  <div className="card fade-in segment-card dialogue-list-card">
                    <div className="row" style={{justifyContent:'space-between', marginBottom:8}}>
                      <div>
                        <div style={{fontWeight:700}}>完整台词列表</div>
                        <div className="badge-sm">显示 {dialogueRows.length} / {sortedSegmentRows.length}，点击任意行跳转</div>
                      </div>
                    </div>
                    <div className="dialogue-workbar" aria-label="当前台词快捷校对">
                      <div className="dialogue-workbar-current">
                        <span className="dialogue-workbar-eyebrow">
                          {selectedSegmentRowNumber > 0 ? `当前第 ${selectedSegmentRowNumber} 句` : '尚未选择台词'}
                        </span>
                        {selectedSegment ? (
                          <div className="dialogue-workbar-meta">
                            <span>{formatHMSms(selectedSegment.start)} - {formatHMSms(selectedSegment.end)}</span>
                            <button
                              type="button"
                              className="dialogue-workbar-speaker"
                              title="修改当前台词说话人"
                              onClick={(event) => openInlineSpeakerPicker(
                                selectedSegment,
                                event.currentTarget.getBoundingClientRect(),
                                'assign',
                                false,
                              )}
                            >
                              {selectedSpeaker?.name || selectedSegment.speakerId}
                              <Pencil size={12} />
                            </button>
                          </div>
                        ) : (
                          <span className="badge-sm">点击下方任意台词开始校对</span>
                        )}
                      </div>
                      <label className="dialogue-workbar-status">
                        <span>状态</span>
                        <select
                          disabled={!selectedSegment}
                          value={selectedSegment?.reviewStatus || 'pending'}
                          onChange={(event) => updateSelectedSegment({ reviewStatus: event.target.value as ReviewStatus })}
                        >
                          <option value="pending">pending</option>
                          <option value="checked">checked</option>
                          <option value="corrected">corrected</option>
                          <option value="inserted">inserted</option>
                          <option value="uncertain">uncertain</option>
                          <option value="deleted">deleted</option>
                        </select>
                      </label>
                      <div className="dialogue-workbar-actions">
                        <button
                          type="button"
                          className="btn tiny"
                          disabled={!selectedSegment}
                          onClick={(event) => {
                            if (!selectedSegment) return
                            openInlineSpeakerPicker(
                              selectedSegment,
                              event.currentTarget.getBoundingClientRect(),
                              'add',
                              false,
                            )
                          }}
                        >
                          <Plus size={14} />新增说话人
                        </button>
                        <button
                          type="button"
                          className="btn tiny pass-btn"
                          disabled={!selectedSegment}
                          onClick={markSelectedAsChecked}
                        >
                          <Check size={14} />通过检查
                        </button>
                      </div>
                    </div>
                    <div className="segment-toolbar">
                      <select
                        value={segmentStatusFilter}
                        onChange={(event) => setSegmentStatusFilter(event.target.value as ReviewStatus | 'all')}
                      >
                        <option value="all">全部状态</option>
                        <option value="pending">pending</option>
                        <option value="checked">checked</option>
                        <option value="corrected">corrected</option>
                        <option value="inserted">inserted</option>
                        <option value="uncertain">uncertain</option>
                        <option value="deleted">deleted</option>
                      </select>
                      <select
                        value={segmentSpeakerFilter}
                        onChange={(event) => setSegmentSpeakerFilter(event.target.value)}
                      >
                        <option value="all">全部说话人</option>
                        {speakers.map((speaker) => (
                          <option key={speaker.id} value={speaker.id}>{speaker.name}</option>
                        ))}
                      </select>
                      <button
                        className="btn tiny"
                        disabled={reviewProgress.counts.pending === 0}
                        onClick={() => jumpToNextStatus('pending')}
                      >
                        下一条 pending
                      </button>
                      <button
                        className="btn tiny"
                        disabled={filteredPendingCount === 0}
                        onClick={markFilteredPendingRowsAsChecked}
                      >
                        当前筛选通过 {filteredPendingCount}
                      </button>
                    </div>
                    <div className="segment-table dialogue-table" ref={dialogueListRef} onScroll={onDialogueListScroll}>
                      {virtualDialogueRows.topPadding > 0 && (
                        <div className="dialogue-spacer" style={{height: virtualDialogueRows.topPadding}} />
                      )}
                      {virtualDialogueRows.rows.map(({ segment, index }) => {
                        const speaker = speakers.find((item) => item.id === segment.speakerId)
                        const status = segment.reviewStatus || 'pending'
                        const isPlayback = activePlaybackSegmentId === segment.id
                        const isSelected = selectedSegId === segment.id && (!isPlaying || !activePlaybackSegmentId)
                        const rowSubtitle = segment.text?.trim() ? null : findBestSubtitleForSegment(segment, allSubtitles)
                        const rowTextRaw = segment.text?.trim() || rowSubtitle?.text || '-'
                        const rowText = stripSpeakerPrefix(rowTextRaw, speakerTextLabels)
                        const originalSpeaker = segment.originalSpeakerId
                          ? speakers.find((item) => item.id === segment.originalSpeakerId)
                          : null
                        const revision = buildSegmentRevisionSummary(segment, {
                          originalSpeakerName: originalSpeaker?.name || segment.originalSpeakerId,
                          currentSpeakerName: speaker?.name || segment.speakerId,
                          currentText: rowText,
                        })
                        const isEditingText = inlineTextEdit?.segmentId === segment.id
                        return (
                          <div
                            key={segment.id}
                            role="button"
                            tabIndex={0}
                            className={`segment-row dialogue-row status-${status}${isPlayback ? ' playing' : ''}${isSelected ? ' current' : ''}`}
                            title={[
                              rowText,
                              revision.speakerLine ? `原说话人：${revision.speakerLine}` : '',
                              revision.textLine ? `原台词：${revision.textLine}` : '',
                            ].filter(Boolean).join('\n')}
                            onClick={() => {
                              setFollowPlayback(true)
                              filteredPlaybackSessionRef.current = filteredPlaybackMode
                              setSelectedSegId(segment.id)
                              seek(segment.start, { preserveFilteredPlayback: true })
                            }}
                            onContextMenu={(event) => {
                              if ((event.target as HTMLElement).closest('input, textarea, select')) return
                              event.preventDefault()
                              openInlineSpeakerPicker(segment, {
                                left: event.clientX,
                                right: event.clientX + 1,
                                top: event.clientY,
                                bottom: event.clientY + 1,
                              })
                            }}
                            onKeyDown={(event) => {
                              if (event.target !== event.currentTarget) return
                              if (event.key !== 'Enter' && event.key !== ' ') return
                              event.preventDefault()
                              setFollowPlayback(true)
                              filteredPlaybackSessionRef.current = filteredPlaybackMode
                              setSelectedSegId(segment.id)
                              seek(segment.start, { preserveFilteredPlayback: true })
                            }}
                          >
                            <span>{index + 1}</span>
                            <span>{formatHMSms(segment.start)}</span>
                            <span>{formatHMSms(segment.end)}</span>
                            <div className={`dialogue-speaker-cell${revision.hasSpeakerChanged ? ' has-original' : ''}`}>
                              <button
                                type="button"
                                className="dialogue-speaker-edit-trigger"
                                aria-label={`修改第 ${index + 1} 句说话人`}
                                title="点击修改说话人；也可以右键整行"
                                onClick={(event) => {
                                  event.stopPropagation()
                                  openInlineSpeakerPicker(segment, event.currentTarget.getBoundingClientRect())
                                }}
                              >
                                <span className="dialogue-speaker-color" style={{ background: speaker?.color || '#64748b' }} />
                                <span className="dialogue-speaker-label">
                                  <strong>{speaker?.name || segment.speakerId}</strong>
                                  <small>ID: {segment.speakerId}</small>
                                </span>
                                <Pencil size={12} className="dialogue-speaker-edit-icon" />
                              </button>
                              {revision.hasSpeakerChanged && (
                                <small className="dialogue-original-speaker" title={revision.speakerLine}>
                                  原：{originalSpeaker?.name || segment.originalSpeakerId}
                                </small>
                              )}
                            </div>
                            <span className="dialogue-status-cell">
                              <span>{status}</span>
                              {revision.badges.length > 0 && (
                                <small>{revision.badges.join(' / ')}</small>
                              )}
                            </span>
                            <div className={`dialogue-text-cell${revision.hasTextChanged ? ' has-original' : ''}`}>
                              {isEditingText ? (
                                <div
                                  className="dialogue-inline-editor"
                                  onClick={(event) => event.stopPropagation()}
                                  onBlur={(event) => {
                                    const nextFocus = event.relatedTarget
                                    if (nextFocus instanceof Node && event.currentTarget.contains(nextFocus)) return
                                    commitInlineTextEdit(segment.id, inlineTextEdit.value)
                                  }}
                                >
                                  <textarea
                                    autoFocus
                                    rows={2}
                                    aria-label={`编辑第 ${index + 1} 句台词`}
                                    value={inlineTextEdit.value}
                                    onChange={(event) => setInlineTextEdit({ segmentId: segment.id, value: event.target.value })}
                                    onKeyDown={(event) => {
                                      if (event.nativeEvent.isComposing) return
                                      if (event.key === 'Escape') {
                                        event.preventDefault()
                                        setInlineTextEdit(null)
                                      } else if (event.key === 'Enter' && !event.shiftKey) {
                                        event.preventDefault()
                                        commitInlineTextEdit(segment.id, inlineTextEdit.value)
                                      }
                                    }}
                                  />
                                  <div className="dialogue-inline-actions">
                                    <button
                                      type="button"
                                      aria-label="保存台词修改"
                                      title="保存（Enter）"
                                      onMouseDown={(event) => event.preventDefault()}
                                      onClick={() => commitInlineTextEdit(segment.id, inlineTextEdit.value)}
                                    >
                                      <Check size={14} />
                                    </button>
                                    <button
                                      type="button"
                                      aria-label="取消台词修改"
                                      title="取消（Esc）"
                                      onMouseDown={(event) => event.preventDefault()}
                                      onClick={() => setInlineTextEdit(null)}
                                    >
                                      <X size={14} />
                                    </button>
                                  </div>
                                </div>
                              ) : (
                                <>
                                  <button
                                    type="button"
                                    className="dialogue-text-edit-trigger"
                                    title="点击直接修改台词"
                                    onClick={(event) => {
                                      event.stopPropagation()
                                      setFollowPlayback(false)
                                      setSelectedSegId(segment.id)
                                      seek(segment.start)
                                      setInlineTextEdit({
                                        segmentId: segment.id,
                                        value: rowText === '-' ? '' : rowText,
                                      })
                                    }}
                                  >
                                    <span className="dialogue-text">{rowText}</span>
                                    <Pencil size={13} className="dialogue-edit-icon" />
                                  </button>
                                  {revision.hasTextChanged && (
                                    <small className="dialogue-original-text" title={segment.originalText || '（空）'}>
                                      原：{segment.originalText || '（空）'}
                                    </small>
                                  )}
                                </>
                              )}
                            </div>
                          </div>
                        )
                      })}
                      {virtualDialogueRows.bottomPadding > 0 && (
                        <div className="dialogue-spacer" style={{height: virtualDialogueRows.bottomPadding}} />
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
      {inlineSpeakerPicker && inlineSpeakerPickerSegment && (
        <div
          ref={inlineSpeakerPickerRef}
          className="inline-speaker-picker"
          role="dialog"
          aria-label={inlineSpeakerPicker.mode === 'add' ? '新增说话人' : '修改当前台词说话人'}
          style={{ left: inlineSpeakerPicker.x, top: inlineSpeakerPicker.y }}
          onContextMenu={(event) => event.preventDefault()}
        >
          <div className="inline-speaker-picker-header">
            <div>
              <strong>{inlineSpeakerPicker.mode === 'add' ? '新增或选择说话人' : '修改说话人'}</strong>
              <small>
                {formatHMSms(inlineSpeakerPickerSegment.start)} · 当前：
                {speakers.find((speaker) => speaker.id === inlineSpeakerPickerSegment.speakerId)?.name || inlineSpeakerPickerSegment.speakerId}
              </small>
            </div>
            <button
              type="button"
              className="inline-speaker-picker-close"
              aria-label="关闭说话人选择器"
              onClick={() => setInlineSpeakerPicker(null)}
            >
              <X size={15} />
            </button>
          </div>
          <label className="inline-speaker-search">
            <Search size={15} />
            <input
              autoFocus
              value={inlineSpeakerPicker.query}
              onChange={(event) => setInlineSpeakerPicker((current) => current
                ? { ...current, query: event.target.value }
                : current)}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) return
                const query = inlineSpeakerPicker.query.trim()
                const hasExactSpeaker = speakers.some((speaker) => speaker.id === query || speaker.name === query)
                if (event.key === 'Enter' && inlineSpeakerPicker.mode === 'add' && query && !hasExactSpeaker) {
                  event.preventDefault()
                  addInlineSpeakerOnly()
                  return
                }
                if (event.key === 'Enter' && inlineSpeakerPickerOptions.length === 1) {
                  event.preventDefault()
                  assignSpeakerToSegment(inlineSpeakerPickerSegment.id, inlineSpeakerPickerOptions[0])
                }
              }}
              placeholder={inlineSpeakerPicker.mode === 'add' ? '输入新说话人姓名或搜索已有 ID' : '搜索姓名或说话人 ID'}
            />
          </label>
          <div className="inline-speaker-options">
            {inlineSpeakerPickerOptions.map((speaker) => {
              const isCurrent = speaker.id === inlineSpeakerPickerSegment.speakerId
              const isRecent = recentSpeakerIds.includes(speaker.id)
              const usageCount = speakerUsageCounts.get(speaker.id) || 0
              const isManualSpeaker = speaker.source === 'manual'
              return (
                <div className="inline-speaker-option-row" key={speaker.id}>
                  <button
                    type="button"
                    className={`inline-speaker-option${isCurrent ? ' current' : ''}`}
                    onClick={() => assignSpeakerToSegment(inlineSpeakerPickerSegment.id, speaker)}
                  >
                    <span className="inline-speaker-option-color" style={{ background: speaker.color }} />
                    <span>
                      <strong>{speaker.name}</strong>
                      <small>{speaker.id}</small>
                    </span>
                    {isRecent && <em>最近</em>}
                    {isCurrent && <Check size={15} />}
                  </button>
                  {isManualSpeaker && (
                    <button
                      type="button"
                      className={`inline-speaker-delete${usageCount > 0 ? ' blocked' : ''}`}
                      title={usageCount > 0
                        ? `已有 ${usageCount} 个片段使用该说话人，需先改为其他说话人`
                        : `删除人工新增说话人 ${speaker.name}`}
                      aria-label={`删除人工新增说话人 ${speaker.name}`}
                      onClick={() => removeManualSpeaker(speaker)}
                    >
                      <Trash2 size={13} />
                    </button>
                  )}
                </div>
              )
            })}
            {inlineSpeakerPickerOptions.length === 0 && (
              <div className="inline-speaker-empty">没有匹配的说话人</div>
            )}
          </div>
          {inlineSpeakerPicker.query.trim() && !speakers.some((speaker) => (
            speaker.id === inlineSpeakerPicker.query.trim() || speaker.name === inlineSpeakerPicker.query.trim()
          )) && (
            <div className="inline-speaker-add-actions">
              <button type="button" className="inline-speaker-add" onClick={addInlineSpeakerOnly}>
                <Plus size={15} />
                仅新增“{inlineSpeakerPicker.query.trim()}”
              </button>
              <button type="button" className="inline-speaker-add primary" onClick={addInlineSpeakerAndAssign}>
                新增并用于当前
              </button>
            </div>
          )}
          <div className="inline-speaker-picker-hint">
            单击已有说话人会立即应用；人工漏句保持 inserted，其他修改标记 corrected · 只有人工新增且未使用的说话人可删除
          </div>
        </div>
      )}
      {/* Delete confirmation modal */}
      {confirmDelete?.open && (
        <div className="modal-backdrop" onClick={()=> setConfirmDelete(null)}>
          <div className="modal" onClick={(e)=> e.stopPropagation()}>
            <div style={{fontWeight:700, marginBottom:8}}>确认删除</div>
            <div className="badge-sm" style={{marginBottom:12}}>删除后该时间段将被移除（可撤销）。</div>
            <div className="row" style={{justifyContent:'flex-end', gap:8}}>
              <button className="btn" onClick={()=> setConfirmDelete(null)}>取消</button>
              <button className="btn primary" autoFocus onClick={()=>{ if(confirmDelete) removeTimeSegment(confirmDelete.segId); setConfirmDelete(null) }}>删除</button>
            </div>
          </div>
        </div>
      )}
      {/* Undo toast */}
      {toast && (
        <div className="toast">
          <span>{toast.message}</span>
          {toast.onAction && (
            <button className="link" onClick={toast.onAction}>{toast.actionLabel || '操作'}</button>
          )}
        </div>
      )}
    </div>
  )
}

export default function App() {
  return (
    <AppErrorBoundary>
      <AppContent />
    </AppErrorBoundary>
  )
}
