export type ReviewPrimaryAction = 'nextPending' | 'changeSpeaker' | 'insertMissing' | 'pass'

export const REVIEW_PRIMARY_ACTION_LABELS: Record<ReviewPrimaryAction, string> = {
  nextPending: '下一条待处理',
  changeSpeaker: '改说话人',
  insertMissing: '插入漏句',
  pass: '通过检查',
}

export function getReviewPrimaryActionOrder(hasSelectedSegment: boolean): ReviewPrimaryAction[] {
  if (!hasSelectedSegment) return ['nextPending']
  return ['nextPending', 'changeSpeaker', 'insertMissing', 'pass']
}
