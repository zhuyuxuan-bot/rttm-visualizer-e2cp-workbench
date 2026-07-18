import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle, Check, Filter, Send } from 'lucide-react'

import {
  getLatestReviewEvent,
  summarizeReviewWorkspace,
  type ReviewEvent,
  type ReviewIssueType,
  type ReviewSegmentStatus,
  type ReviewValueSnapshot,
  type ReviewWorkspace,
} from './reviewWorkflow'

export interface ReviewDisplaySegment {
  id: string
  index: number
  start: number
  end: number
  speakerId: string
  speakerName: string
  speakerColor: string
  text: string
}

export interface ReviewSpeakerOption {
  id: string
  name: string
}

export interface ReviewActionRequest {
  action: 'approved' | 'issue_reported' | 'change_proposed' | 'resolved'
  issueTypes: ReviewIssueType[]
  before: ReviewValueSnapshot
  proposedAfter?: ReviewValueSnapshot
  reason: string
  evidenceTimeMs?: number
}

interface ReviewWorkbenchProps {
  segments: ReviewDisplaySegment[]
  speakers: ReviewSpeakerOption[]
  selectedSegmentId: string | null
  currentTime: number
  workspace: ReviewWorkspace
  onSelectSegment: (segment: ReviewDisplaySegment) => void
  onReviewAction: (segment: ReviewDisplaySegment, request: ReviewActionRequest) => void
}

type ReviewFilter = 'all' | 'unreviewed' | 'issue' | 'awaiting' | 'resolved'

const STATUS_LABELS: Record<ReviewSegmentStatus, string> = {
  unreviewed: '未检查',
  approved: '检查通过',
  issue_open: '发现问题',
  awaiting_annotator: '待标注人处理',
  annotator_replied: '标注人已回复',
  resolved: '已解决',
}

const ISSUE_LABELS: Record<ReviewIssueType, string> = {
  speaker: '说话人错误',
  text: '台词错误',
  timing: '时间错误',
  extra: '多余台词',
  missing: '漏标台词',
  other: '其他问题',
}

const ACTION_LABELS: Record<ReviewEvent['action'], string> = {
  approved: '通过本句',
  issue_reported: '发现问题',
  change_proposed: '提交修改建议',
  annotator_replied: '标注人回复',
  resolved: '确认已解决',
  reopened: '重新打开',
}

function formatReviewTime(seconds: number, withMilliseconds = false): string {
  const safe = Math.max(0, seconds)
  const minutes = Math.floor(safe / 60)
  const remainder = safe - minutes * 60
  return withMilliseconds
    ? `${minutes}:${remainder.toFixed(3).padStart(6, '0')}`
    : `${minutes}:${remainder.toFixed(1).padStart(4, '0')}`
}

function makeSnapshot(segment: ReviewDisplaySegment): ReviewValueSnapshot {
  return {
    speaker_id: segment.speakerId,
    speaker_name: segment.speakerName,
    text: segment.text,
    start_ms: Math.round(segment.start * 1000),
    end_ms: Math.round(segment.end * 1000),
  }
}

function rowMatchesFilter(status: ReviewSegmentStatus, filter: ReviewFilter): boolean {
  if (filter === 'all') return true
  if (filter === 'unreviewed') return status === 'unreviewed'
  if (filter === 'issue') return status === 'issue_open'
  if (filter === 'awaiting') return status === 'awaiting_annotator' || status === 'annotator_replied'
  return status === 'resolved'
}

export function ReviewWorkbench({
  segments,
  speakers,
  selectedSegmentId,
  currentTime,
  workspace,
  onSelectSegment,
  onReviewAction,
}: ReviewWorkbenchProps) {
  const [filter, setFilter] = useState<ReviewFilter>('all')
  const [continuousReview, setContinuousReview] = useState(false)
  const [issueTypes, setIssueTypes] = useState<ReviewIssueType[]>([])
  const [reason, setReason] = useState('')
  const [proposedSpeakerId, setProposedSpeakerId] = useState('')
  const [proposedText, setProposedText] = useState('')
  const [proposedStart, setProposedStart] = useState('')
  const [proposedEnd, setProposedEnd] = useState('')
  const dialogueListRef = useRef<HTMLDivElement>(null)
  const summary = useMemo(() => summarizeReviewWorkspace(workspace), [workspace])

  const selectedSegment = useMemo(
    () => segments.find((segment) => segment.id === selectedSegmentId) ?? segments[0] ?? null,
    [segments, selectedSegmentId],
  )
  const playingSegment = useMemo(
    () => segments.find((segment) => currentTime >= segment.start && currentTime < segment.end) ?? null,
    [currentTime, segments],
  )
  const filteredSegments = useMemo(
    () => segments.filter((segment) => rowMatchesFilter(workspace.segment_states[segment.id]?.status ?? 'unreviewed', filter)),
    [filter, segments, workspace.segment_states],
  )
  const selectedLatestEvent = selectedSegment
    ? getLatestReviewEvent(workspace, selectedSegment.id)
    : null

  useEffect(() => {
    if (!selectedSegment) return
    const latestProposal = selectedLatestEvent?.proposed_after
    setIssueTypes(selectedLatestEvent?.issue_types ?? [])
    setReason(selectedLatestEvent?.reason ?? '')
    setProposedSpeakerId(latestProposal?.speaker_id ?? selectedSegment.speakerId)
    setProposedText(latestProposal?.text ?? selectedSegment.text)
    setProposedStart(((latestProposal?.start_ms ?? Math.round(selectedSegment.start * 1000)) / 1000).toFixed(3))
    setProposedEnd(((latestProposal?.end_ms ?? Math.round(selectedSegment.end * 1000)) / 1000).toFixed(3))
  }, [selectedLatestEvent?.id, selectedSegment?.id])

  useEffect(() => {
    const activeId = playingSegment?.id
    if (!activeId) return
    const row = dialogueListRef.current?.querySelector<HTMLElement>(`[data-review-segment-id="${CSS.escape(activeId)}"]`)
    row?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [playingSegment?.id])

  const selectNextUnreviewed = () => {
    if (segments.length === 0) return
    const selectedIndex = selectedSegment ? segments.findIndex((segment) => segment.id === selectedSegment.id) : -1
    const ordered = [...segments.slice(selectedIndex + 1), ...segments.slice(0, selectedIndex + 1)]
    const next = ordered.find((segment) => workspace.segment_states[segment.id]?.status === 'unreviewed')
    if (next) onSelectSegment(next)
  }

  const runAction = (action: ReviewActionRequest['action']) => {
    if (!selectedSegment) return
    const before = makeSnapshot(selectedSegment)
    const speaker = speakers.find((item) => item.id === proposedSpeakerId)
    const proposedAfter: ReviewValueSnapshot = {
      speaker_id: proposedSpeakerId || selectedSegment.speakerId,
      speaker_name: speaker?.name || proposedSpeakerId || selectedSegment.speakerName,
      text: proposedText,
      start_ms: Math.round((Number(proposedStart) || selectedSegment.start) * 1000),
      end_ms: Math.round((Number(proposedEnd) || selectedSegment.end) * 1000),
    }
    onReviewAction(selectedSegment, {
      action,
      issueTypes: action === 'approved' || action === 'resolved' ? [] : issueTypes,
      before,
      proposedAfter: action === 'change_proposed' ? proposedAfter : undefined,
      reason: action === 'approved' ? '复核无异议' : action === 'resolved' ? '标注人回改已核验' : reason.trim(),
      evidenceTimeMs: Math.round(currentTime * 1000),
    })
    if (continuousReview) window.setTimeout(selectNextUnreviewed, 0)
  }

  const selectedStatus = selectedSegment
    ? workspace.segment_states[selectedSegment.id]?.status ?? 'unreviewed'
    : 'unreviewed'
  const original = selectedSegment ? makeSnapshot(selectedSegment) : null
  const proposalSpeaker = speakers.find((speaker) => speaker.id === proposedSpeakerId)
  const hasProposalChange = Boolean(original) && (
    proposedSpeakerId !== original?.speaker_id ||
    proposedText !== original?.text ||
    Math.round((Number(proposedStart) || 0) * 1000) !== original?.start_ms ||
    Math.round((Number(proposedEnd) || 0) * 1000) !== original?.end_ms
  )

  return (
    <div className="inspection-workbench">
      <section className="inspection-card inspection-dialogues">
        <div className="inspection-section-heading">
          <div>
            <h2>完整台词列表</h2>
            <p>逐句复核原始标注，播放位置与检查行同步</p>
          </div>
          <button type="button" className="inspection-filter-button"><Filter size={14} />筛选</button>
        </div>
        <div className="inspection-filter-tabs" role="tablist" aria-label="复核状态筛选">
          <button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>全部 <b>{summary.total}</b></button>
          <button className={filter === 'unreviewed' ? 'active' : ''} onClick={() => setFilter('unreviewed')}>未检查 <b>{summary.unreviewed}</b></button>
          <button className={filter === 'issue' ? 'active issue' : ''} onClick={() => setFilter('issue')}>有异议 <b>{summary.issueOpen}</b></button>
          <button className={filter === 'awaiting' ? 'active waiting' : ''} onClick={() => setFilter('awaiting')}>待回改 <b>{summary.awaitingAnnotator + summary.annotatorReplied}</b></button>
          <button className={filter === 'resolved' ? 'active resolved' : ''} onClick={() => setFilter('resolved')}>已解决 <b>{summary.resolved}</b></button>
        </div>
        <div className="inspection-dialogue-header" aria-hidden="true">
          <span>#</span><span>开始时间</span><span>结束时间</span><span>说话人（原始）</span><span>状态</span><span>台词（原始）</span>
        </div>
        <div className="inspection-dialogue-list" ref={dialogueListRef}>
          {filteredSegments.map((segment) => {
            const status = workspace.segment_states[segment.id]?.status ?? 'unreviewed'
            const isSelected = segment.id === selectedSegment?.id
            const isPlaying = segment.id === playingSegment?.id
            return (
              <button
                type="button"
                key={segment.id}
                data-review-segment-id={segment.id}
                className={`inspection-dialogue-row${isSelected ? ' selected' : ''}${isPlaying ? ' playing' : ''}`}
                onClick={() => onSelectSegment(segment)}
              >
                <span>{isPlaying ? '▶ ' : ''}{segment.index}</span>
                <span>{formatReviewTime(segment.start, true)}</span>
                <span>{formatReviewTime(segment.end, true)}</span>
                <span className="inspection-speaker-cell"><i style={{ background: segment.speakerColor }} />{segment.speakerName}</span>
                <span className={`inspection-status status-${status}`}>{STATUS_LABELS[status]}</span>
                <span className="inspection-text-cell">{segment.text || '（无台词文本）'}</span>
              </button>
            )
          })}
          {filteredSegments.length === 0 && <div className="inspection-empty">当前筛选下没有台词</div>}
        </div>
      </section>

      <section className="inspection-card inspection-current">
        <div className="inspection-current-heading">
          <h2>当前句检查</h2>
          <strong>{selectedSegment ? `${formatReviewTime(selectedSegment.start, true)} – ${formatReviewTime(selectedSegment.end, true)}` : '未选择'}</strong>
          <label className="inspection-continuous-toggle">
            连续复核：{continuousReview ? '开' : '关'}
            <input type="checkbox" checked={continuousReview} onChange={(event) => setContinuousReview(event.target.checked)} />
            <span />
          </label>
        </div>
        {selectedSegment && original ? (
          <>
            <div className="inspection-compare-grid">
              <div className="inspection-original-card">
                <h3>原始标注 <small>来自标注工程</small></h3>
                <label>说话人<input value={selectedSegment.speakerName} readOnly /></label>
                <label>台词<textarea value={selectedSegment.text} readOnly rows={2} /></label>
                <div className="inspection-time-pair"><span>{formatReviewTime(selectedSegment.start, true)}</span><span>{formatReviewTime(selectedSegment.end, true)}</span></div>
              </div>
              <div className="inspection-compare-arrow">→</div>
              <div className={`inspection-proposal-card${hasProposalChange ? ' changed' : ''}`}>
                <h3>检查建议 <small>{selectedLatestEvent ? '已有留痕' : '尚未提交'}</small></h3>
                <label>说话人
                  <select value={proposedSpeakerId} onChange={(event) => setProposedSpeakerId(event.target.value)}>
                    {speakers.map((speaker) => <option key={speaker.id} value={speaker.id}>{speaker.name}</option>)}
                  </select>
                </label>
                <label>台词<textarea value={proposedText} onChange={(event) => setProposedText(event.target.value)} rows={2} /></label>
                <div className="inspection-time-pair editable">
                  <input type="number" step="0.001" value={proposedStart} onChange={(event) => setProposedStart(event.target.value)} />
                  <input type="number" step="0.001" value={proposedEnd} onChange={(event) => setProposedEnd(event.target.value)} />
                </div>
                {hasProposalChange && (
                  <div className="inspection-diff-line">
                    {original.speaker_name !== (proposalSpeaker?.name || proposedSpeakerId) && <span>{original.speaker_name} → {proposalSpeaker?.name || proposedSpeakerId}</span>}
                    {original.text !== proposedText && <span>{original.text || '（空）'} → {proposedText || '（空）'}</span>}
                  </div>
                )}
              </div>
              <aside className="inspection-issue-box">
                <h3>问题类型</h3>
                <div className="inspection-issue-types">
                  {(Object.keys(ISSUE_LABELS) as ReviewIssueType[]).map((issueType) => (
                    <button
                      type="button"
                      key={issueType}
                      className={issueTypes.includes(issueType) ? 'active' : ''}
                      onClick={() => setIssueTypes((current) => current.includes(issueType)
                        ? current.filter((item) => item !== issueType)
                        : [...current, issueType])}
                    >{ISSUE_LABELS[issueType]}</button>
                  ))}
                </div>
                <label>证据时间<strong>{formatReviewTime(currentTime, true)}</strong></label>
                <span className={`inspection-current-status status-${selectedStatus}`}>{STATUS_LABELS[selectedStatus]}</span>
              </aside>
            </div>
            <label className="inspection-reason-field">
              <span>问题原因（有异议时必填）</span>
              <input value={reason} onChange={(event) => setReason(event.target.value)} placeholder="例如：画面与声纹均指向另一位说话人；字幕遗漏了两个字" />
            </label>
            <div className="inspection-primary-actions">
              <button className="inspection-approve" type="button" onClick={() => runAction(selectedStatus === 'annotator_replied' ? 'resolved' : 'approved')}>
                <Check size={18} />{selectedStatus === 'annotator_replied' ? '确认已解决' : '通过本句'}
              </button>
              <button className="inspection-issue" type="button" disabled={issueTypes.length === 0 || !reason.trim()} onClick={() => runAction('issue_reported')}>
                <AlertCircle size={18} />发现问题
              </button>
              <button className="inspection-submit" type="button" disabled={!hasProposalChange || issueTypes.length === 0 || !reason.trim()} onClick={() => runAction('change_proposed')}>
                <Send size={18} />提交修改建议
              </button>
            </div>
          </>
        ) : <div className="inspection-empty">请从上方列表选择一句台词开始检查</div>}
      </section>

      <section className="inspection-card inspection-audit-log">
        <div className="inspection-audit-heading">
          <h2>操作记录 <small>不可删除</small></h2>
          <div className="inspection-round-stats">
            <span>本轮复核统计</span>
            <b className="unreviewed">未检查 {summary.unreviewed}</b>
            <b className="issue">有异议 {summary.issueOpen}</b>
            <b className="waiting">待回改 {summary.awaitingAnnotator + summary.annotatorReplied}</b>
            <b className="resolved">已解决 {summary.resolved}</b>
          </div>
        </div>
        <div className="inspection-audit-table">
          <div className="inspection-audit-row header"><span>时间</span><span>操作者</span><span>操作类型</span><span>变更内容（前 → 后）</span><span>原因/备注</span><span>状态</span></div>
          {[...workspace.events].reverse().slice(0, 12).map((event) => (
            <div className="inspection-audit-row" key={event.id}>
              <span>{new Date(event.created_at).toLocaleString('zh-CN', { hour12: false })}</span>
              <span>{event.actor.name}</span>
              <span>{ACTION_LABELS[event.action]}</span>
              <span>{event.proposed_after
                ? `${event.before.speaker_name} → ${event.proposed_after.speaker_name}；${event.before.text || '（空）'} → ${event.proposed_after.text || '（空）'}`
                : '—'}</span>
              <span>{event.reason || '—'}</span>
              <span className={`inspection-status status-${workspace.segment_states[event.segment_id]?.status || 'unreviewed'}`}>
                {STATUS_LABELS[workspace.segment_states[event.segment_id]?.status || 'unreviewed']}
              </span>
            </div>
          ))}
          {workspace.events.length === 0 && <div className="inspection-empty compact">本轮尚无操作记录</div>}
        </div>
      </section>
    </div>
  )
}
