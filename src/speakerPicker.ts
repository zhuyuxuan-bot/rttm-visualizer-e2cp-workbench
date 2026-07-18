export interface SpeakerPickerOption {
  id: string
  name: string
}

export interface SpeakerPickerRect {
  left: number
  right: number
  top: number
  bottom: number
}

export function getSpeakerPickerPosition(
  anchor: SpeakerPickerRect,
  viewport: { width: number; height: number },
  popup: { width: number; height: number },
  gap = 8,
): { x: number; y: number } {
  const margin = 10
  const maxX = Math.max(margin, viewport.width - popup.width - margin)
  const x = Math.max(margin, Math.min(maxX, anchor.left))
  const spaceBelow = viewport.height - anchor.bottom
  const preferredY = spaceBelow >= popup.height + gap
    ? anchor.bottom + gap
    : anchor.top - popup.height - gap
  const maxY = Math.max(margin, viewport.height - popup.height - margin)
  const y = Math.max(margin, Math.min(maxY, preferredY))
  return { x, y }
}

export function orderSpeakerPickerOptions<TSpeaker extends SpeakerPickerOption>(
  speakers: TSpeaker[],
  recentSpeakerIds: string[],
  query: string,
): TSpeaker[] {
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const recentOrder = new Map(recentSpeakerIds.map((id, index) => [id, index]))
  return speakers
    .filter((speaker) => {
      if (!normalizedQuery) return true
      return speaker.name.toLocaleLowerCase().includes(normalizedQuery)
        || speaker.id.toLocaleLowerCase().includes(normalizedQuery)
    })
    .slice()
    .sort((left, right) => {
      const leftRecent = recentOrder.get(left.id)
      const rightRecent = recentOrder.get(right.id)
      if (leftRecent !== undefined || rightRecent !== undefined) {
        if (leftRecent === undefined) return 1
        if (rightRecent === undefined) return -1
        return leftRecent - rightRecent
      }
      return left.name.localeCompare(right.name, 'zh-CN')
    })
}

export function updateRecentSpeakerIds(
  recentSpeakerIds: string[],
  speakerId: string,
  limit = 5,
): string[] {
  return [speakerId, ...recentSpeakerIds.filter((id) => id !== speakerId)].slice(0, limit)
}
