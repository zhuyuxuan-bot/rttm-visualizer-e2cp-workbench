import test from 'node:test'
import assert from 'node:assert/strict'

import {
  episodeFileMatches,
  getEpisodeWorkPackage,
  summarizeBundledEpisodeAssets,
} from '../src/episodePackages.ts'

test('getEpisodeWorkPackage marks available early episodes as standard RTTM packages', () => {
  const ep02 = getEpisodeWorkPackage('02')

  assert.equal(ep02.rttmKind, 'standard')
  assert.equal(ep02.rttmLabel, '标准 RTTM')
})

test('getEpisodeWorkPackage marks known missing-trimodal and late episodes as initial RTTM packages', () => {
  assert.equal(getEpisodeWorkPackage('08').rttmKind, 'initial')
  assert.equal(getEpisodeWorkPackage('12').rttmKind, 'initial')
  assert.equal(getEpisodeWorkPackage('15').rttmKind, 'initial')
  assert.equal(getEpisodeWorkPackage('17').rttmKind, 'initial')
})

test('episodeFileMatches accepts common episode filename styles', () => {
  assert.equal(episodeFileMatches('ep17_for_review.srt', '17'), true)
  assert.equal(episodeFileMatches('subseg_match_results_ep17.json', '17'), true)
  assert.equal(episodeFileMatches('ep02.rttm', '17'), false)
})

test('summarizeBundledEpisodeAssets counts only the selected episode resources', () => {
  const summary = summarizeBundledEpisodeAssets({
    episodeId: '02',
    mediaKeys: ['/exp/raw/ep02.mp4', '/exp/raw/ep17.mp4'],
    rttmKeys: ['/exp/rttm/ep02.rttm'],
    srtKeys: ['/exp/srt/ep02_for_review.srt'],
    subsegKeys: [],
  })

  assert.deepEqual(summary, { media: 1, rttm: 1, srt: 1, subseg: 0 })
})
