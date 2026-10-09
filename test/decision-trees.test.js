import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultBom } from '../shared/bom.js';
import { decisionTreeDrl, decisionTreeExecutionTrace, decisionTreeLeaves, decisionTreeRules, newDecisionTree, validateDecisionTree } from '../shared/decision-trees.js';

function sampleTree() {
  const tree = newDecisionTree();
  tree.name = '授信决策树';
  tree.category = 'credit';
  tree.root.condition = { field: 'customerAge', operator: '>=', value: '18' };
  tree.root.trueChild = {
    id: 'score', type: 'condition', condition: { field: 'creditScore', operator: '>=', value: '600' },
    trueChild: { id: 'approved', type: 'result', label: '通过', actions: [{ field: 'riskLevel', value: '低' }] },
    falseChild: { id: 'manual', type: 'result', label: '人工审核', actions: [{ field: 'riskLevel', value: '中' }] },
  };
  tree.root.falseChild = { id: 'rejected', type: 'result', label: '拒绝', actions: [{ field: 'riskLevel', value: '高' }] };
  return tree;
}

test('decision tree validates and compiles every root-to-leaf path', () => {
  const tree = sampleTree();
  assert.equal(validateDecisionTree(tree), null);
  const rules = decisionTreeRules(tree, defaultBom(), 'tree-1');
  assert.equal(rules.length, 3);
  assert.deepEqual(rules.map(rule => rule.decisionTreeLeafId), ['approved', 'manual', 'rejected']);
  assert.deepEqual(rules[0].conditions.map(condition => condition.operator), ['>=', '>=']);
  assert.deepEqual(rules[1].conditions.map(condition => condition.operator), ['>=', '<']);
  assert.deepEqual(rules[2].conditions.map(condition => condition.operator), ['<']);
  assert.deepEqual(rules.map(rule => rule.salience), [3, 2, 1]);
  assert.ok(rules.every(rule => rule.activationGroup === 'decision-tree:tree-1'));
  const drl = decisionTreeDrl(tree, defaultBom(), 'tree-1');
  assert.equal(drl.match(/activation-group "decision-tree:tree-1"/g)?.length, 3);
  assert.match(drl, /customerAge >= 18, creditScore >= 600/);
  assert.match(drl, /customerAge >= 18, creditScore < 600/);
  assert.match(drl, /customerAge < 18/);
});

test('decision tree rejects unsafe branch operators and invalid leaf actions', () => {
  const tree = sampleTree();
  tree.root.condition.operator = 'between';
  assert.match(validateDecisionTree(tree), /不支持决策树分支/);
  tree.root.condition = { field: 'customerAge', operator: '>=', value: '18' };
  tree.root.falseChild.actions = [];
  assert.match(validateDecisionTree(tree), /至少需要一个动作/);
});

test('decision tree exposes stable leaf metadata and execution trace', () => {
  const tree = sampleTree();
  assert.deepEqual(decisionTreeLeaves(tree).map(leaf => [leaf.id, leaf.label]), [
    ['approved', '通过'], ['manual', '人工审核'], ['rejected', '拒绝'],
  ]);
  const rules = decisionTreeRules(tree);
  const fired = [`${rules[1].name} [2]`];
  assert.deepEqual(decisionTreeExecutionTrace(tree, fired).map(entry => ({ leafId: entry.leafId, label: entry.label })), [
    { leafId: 'manual', label: '人工审核' },
  ]);
});
