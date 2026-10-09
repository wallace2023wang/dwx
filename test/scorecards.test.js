import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultBom } from '../shared/bom.js';
import { evaluateScorecard, newScorecard, scorecardDrl, scorecardRules, validateScorecard } from '../shared/scorecards.js';

function sampleScorecard() {
  const scorecard = newScorecard(defaultBom());
  scorecard.name = '授信计分卡';
  scorecard.category = 'credit';
  scorecard.scoreOutputField = 'approvedLimit';
  scorecard.initialScore = 20;
  scorecard.characteristics = [
    { id: 'age', name: '年龄', field: 'customerAge', rows: [
      { id: 'age-young', label: '未满 25', operator: '<', value: '25', score: -10 },
      { id: 'age-default', label: '25 岁及以上', default: true, score: 15 },
    ] },
    { id: 'credit', name: '信用评分', field: 'creditScore', rows: [
      { id: 'credit-low', label: '低于 600', operator: '<', value: '600', score: -30 },
      { id: 'credit-high', label: '600 及以上', default: true, score: 40 },
    ] },
  ];
  scorecard.bands = [
    { id: 'reject', label: '拒绝', min: null, max: 30, actions: [{ field: 'riskLevel', value: '高' }] },
    { id: 'review', label: '人工审核', min: 30, max: 60, actions: [{ field: 'riskLevel', value: '中' }] },
    { id: 'approve', label: '通过', min: 60, max: null, actions: [{ field: 'riskLevel', value: '低' }] },
  ];
  return scorecard;
}

test('scorecard validates and generates one deterministic rule per result band', () => {
  const scorecard = sampleScorecard();
  assert.equal(validateScorecard(scorecard, defaultBom()), null);
  const rules = scorecardRules(scorecard, defaultBom(), 'scorecard-1');
  assert.equal(rules.length, 3);
  assert.ok(rules.every(rule => rule.activationGroup === 'scorecard:scorecard-1'));
  assert.deepEqual(rules.map(rule => rule.salience), [3, 2, 1]);
  const drl = scorecardDrl(scorecard, defaultBom(), 'scorecard-1');
  assert.equal(drl.match(/activation-group "scorecard:scorecard-1"/g)?.length, 3);
  assert.match(drl, /customerAge < 25/);
  assert.match(drl, /creditScore < 600/);
  assert.match(drl, /setApprovedLimit\(\(double\)/);
});

test('scorecard evaluation returns characteristic breakdown and selected band', () => {
  const scorecard = sampleScorecard();
  const approved = evaluateScorecard(scorecard, { customerAge: 30, creditScore: 700 }, defaultBom());
  assert.equal(approved.total, 75);
  assert.equal(approved.bandId, 'approve');
  assert.deepEqual(approved.characteristicHits.map(hit => hit.rowId), ['age-default', 'credit-high']);
  const rejected = evaluateScorecard(scorecard, { customerAge: 20, creditScore: 500 }, defaultBom());
  assert.equal(rejected.total, -20);
  assert.equal(rejected.bandId, 'reject');
});

test('scorecard rejects missing defaults and discontinuous result bands', () => {
  const scorecard = sampleScorecard();
  scorecard.characteristics[0].rows.pop();
  assert.match(validateScorecard(scorecard, defaultBom()), /2–50 个分箱|默认分箱/);
  const gaps = sampleScorecard();
  gaps.bands[1].min = 31;
  assert.match(validateScorecard(gaps, defaultBom()), /重叠或缺口/);
});
