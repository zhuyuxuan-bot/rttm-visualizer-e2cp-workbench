export type RttmKind = 'standard' | 'initial'

export interface EpisodeWorkPackage {
  episodeId: string
  label: string
  rttmKind: RttmKind
  rttmLabel: string
  modalityLabel: string
  expected: {
    media: string[]
    srt: string[]
    rttm: string[]
    subseg: string[]
  }
  note: string
}

const STANDARD_RTTM_EPISODES = new Set([
  '01',
  '02',
  '03',
  '04',
  '05',
  '06',
  '07',
  '09',
  '10',
  '11',
  '13',
  '14',
])

function normalizeEpisodeId(value: string | number): string {
  const raw = String(value).trim()
  const match = raw.match(/\d{1,2}/)
  const n = match ? Math.max(1, Math.min(30, Number(match[0]))) : 1
  return n.toString().padStart(2, '0')
}

export function getEpisodeWorkPackage(value: string | number): EpisodeWorkPackage {
  const episodeId = normalizeEpisodeId(value)
  const episodeNumber = Number(episodeId)
  const rttmKind: RttmKind = STANDARD_RTTM_EPISODES.has(episodeId) ? 'standard' : 'initial'
  const label = `EP${episodeId}`
  const rttmLabel = rttmKind === 'standard' ? '标准 RTTM' : '初始标注 RTTM'
  const modalityLabel = episodeNumber <= 15
    ? (rttmKind === 'standard' ? '三模态工作包' : '三模态缺口集，先按初始标注处理')
    : '双模态工作包'
  const note = rttmKind === 'standard'
    ? '该集可优先上传标准 RTTM；用于确认说话人时间轴。'
    : '该集不要当作标准答案；上传的是初始标注 RTTM，后续需要人工校对。'

  return {
    episodeId,
    label,
    rttmKind,
    rttmLabel,
    modalityLabel,
    expected: {
      media: [
        `ep${episodeId}.mp4`,
        `ep${episodeId}.wav`,
        `${episodeId}.mp4`,
        `${episodeId}.wav`,
      ],
      srt: [
        `ep${episodeId}_for_review.srt`,
        `ep${episodeId}.srt`,
        `${episodeId}.srt`,
      ],
      rttm: [
        `ep${episodeId}.rttm`,
        `EP${episodeId}.rttm`,
        `${episodeId}.rttm`,
      ],
      subseg: [
        `ep${episodeId}_subseg_match_results.json`,
        `subseg_match_results_ep${episodeId}.json`,
        `subseg_match_results.json`,
      ],
    },
    note,
  }
}

export function episodeFileMatches(name: string | undefined, episodeId: string | number): boolean {
  if (!name) return false
  const normalized = normalizeEpisodeId(episodeId)
  const n = Number(normalized)
  const patterns = [
    new RegExp(`\\bep[\\s_-]*0?${n}\\b`, 'i'),
    new RegExp(`(?:^|[^\\d])0?${n}(?:[._\\-\\s/\\\\]|$)`, 'i'),
    new RegExp(`第\\s*0?${n}\\s*[集话話]`, 'i'),
  ]
  return patterns.some((pattern) => pattern.test(name))
}

export function summarizeBundledEpisodeAssets(input: {
  episodeId: string | number
  mediaKeys: string[]
  rttmKeys: string[]
  srtKeys: string[]
  subsegKeys: string[]
}) {
  const count = (keys: string[]) => keys.filter((key) => {
    const fileName = key.split(/[\\/]/).pop() || key
    return episodeFileMatches(fileName, input.episodeId)
  }).length

  return {
    media: count(input.mediaKeys),
    rttm: count(input.rttmKeys),
    srt: count(input.srtKeys),
    subseg: count(input.subsegKeys),
  }
}
