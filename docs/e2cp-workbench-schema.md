# E2CP Review Workbench Schema

This fork keeps the original RTTM visualizer intact and adds a review-oriented data layer for the Three-Body dialogue calibration workflow.

## Goal

The workbench exports one project JSON that can represent both dataset groups:

- Episodes 01-15: audio, text, and optional visual evidence.
- Episodes 16-30: audio and text evidence, with visual marked as missing or not applicable.

Manual reviewers should edit segments in the UI, then export the project JSON. Raw RTTM, SRT, CSV, and standard-answer JSON files should stay as source material unless a later conversion script writes a new derived output.

## Segment Fields

Each reviewed segment contains:

- `id`: stable segment identifier.
- `index`: display order after sorting by start time.
- `start_ms` and `end_ms`: millisecond-level time span.
- `speaker_id` and `speaker_name`: internal speaker key and human-readable label.
- `text`: manually confirmed or corrected utterance text.
- `segment_type`: `dialogue`, `subtitle`, `tail_caption`, `ad`, or `unknown`.
- `review_status`: `pending`, `checked`, `corrected`, `inserted`, `deleted`, or `uncertain`.
- `evidence`: modality-specific provenance from text, audio, visual, fusion, or waveform checks.
- `notes`: reviewer notes and reasons.

## Review Rules

- Speaker error: select the segment, change `Speaker`, and mark it `corrected`.
- Text error: select the segment, edit `Text`, and mark it `corrected`.
- Missing utterance: use the waveform suspected-gap panel or click a track to insert a segment, fill `Speaker` and `Text`, then keep status `inserted` or change to `corrected` after confirmation.
- Already verified segment: mark `checked` only when no speaker or text correction is needed.
- Uncertain evidence: mark `uncertain` and describe the issue in `Notes`.

## Export Contract

`Export Project JSON` writes:

- source file names,
- modality availability,
- speakers,
- reviewed system segments,
- optional reference RTTM segments,
- suspected waveform gaps.

This JSON is the future bridge for conversion scripts that generate final three-modal fusion JSON, CSV review snapshots, or RTTM/SRT derivatives.
