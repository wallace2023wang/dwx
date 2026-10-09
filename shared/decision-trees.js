import { defaultBom, inputFields, outputFields } from './bom.js';
import { generateDrl, validateRule } from './rules.js';
import { canonicalPackageName, DEFAULT_PACKAGE_NAME, PACKAGE_NAME_RE } from './packages.js';

const DEFAULT_BOM = defaultBom();
const MAX_DEPTH = 8;
const MAX_NODES = 63;
const MAX_LEAVES = 32;
const TREE_PRIORITY_SCALE = 1000000;

const inverseOperators = Object.freeze({
  '==': '!=',
  '!=': '==',
  '>': '<=',
  '>=': '<',
  '<': '>=',
  '<=': '>',
});

function defaultValue(field) {
  if (!field) return '';
  if (field.type === 'Boolean') return 'true';
  if (field.type === 'Integer' || field.type === 'Double') return String(field.min ?? 0);
  return field.enum?.[0] || '';
}

function nodeId(prefix) {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2)}`;
}

function resultNode(output) {
  return {
    id: nodeId('result'),
    type: 'result',
    label: '',
    actions: output ? [{ field: output.key, value: defaultValue(output) }] : [],
  };
}

export function newDecisionTree(bom = DEFAULT_BOM) {
  const input = inputFields(bom)[0];
  const output = outputFields(bom)[0];
  return {
    kind: 'decision-tree',
    name: '未命名决策树',
    description: '',
    category: DEFAULT_PACKAGE_NAME,
    priority: 0,
    root: {
      id: nodeId('condition'),
      type: 'condition',
      condition: {
        field: input?.key || '',
        operator: input?.type === 'Integer' || input?.type === 'Double' ? '>=' : '==',
        value: defaultValue(input),
      },
      trueChild: resultNode(output),
      falseChild: resultNode(output),
    },
  };
}

export function isDecisionTree(value) {
  return value?.kind === 'decision-tree';
}

function inverseCondition(condition) {
  const operator = inverseOperators[condition?.operator];
  if (!operator) throw new Error(`条件运算符 ${condition?.operator || '（空）'} 不支持“否”分支`);
  return { ...structuredClone(condition), operator };
}

function decisionTreePaths(tree) {
  const paths = [];
  const visit = (node, conditions, branches) => {
    if (node.type === 'result') {
      paths.push({ node, conditions, branches });
      return;
    }
    visit(node.trueChild, [...conditions, structuredClone(node.condition)], [...branches, { nodeId: node.id, branch: true }]);
    visit(node.falseChild, [...conditions, inverseCondition(node.condition)], [...branches, { nodeId: node.id, branch: false }]);
  };
  visit(tree.root, [], []);
  return paths;
}

export function decisionTreeLeaves(tree) {
  if (!isDecisionTree(tree) || !tree.root) return [];
  try {
    return decisionTreePaths(tree).map((path, index) => ({
      id: path.node.id,
      label: path.node.label?.trim() || `结果 ${index + 1}`,
      index,
      actions: structuredClone(path.node.actions || []),
      branches: structuredClone(path.branches),
    }));
  } catch {
    return [];
  }
}

export function validateDecisionTree(tree, bom = DEFAULT_BOM, variables = []) {
  if (!isDecisionTree(tree)) return '决策树内容无效';
  if (typeof tree.name !== 'string' || !tree.name.trim() || tree.name.length > 80) return '名称需为 1–80 个字符';
  if (typeof tree.description !== 'string' || tree.description.length > 500) return '说明不能超过 500 个字符';
  if (typeof tree.category !== 'string' || !PACKAGE_NAME_RE.test(canonicalPackageName(tree.category))) return '规则包需为有效英文包名';
  if (!Number.isInteger(tree.priority) || tree.priority < -1000 || tree.priority > 1000) return '优先级需为 -1000 到 1000 的整数';
  if (!tree.root || tree.root.type !== 'condition') return '决策树根节点必须是条件节点';

  const ids = new Set();
  const active = new Set();
  let nodes = 0;
  let leaves = 0;
  const visit = (node, depth) => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return '决策树节点无效';
    if (depth > MAX_DEPTH) return `决策树最多支持 ${MAX_DEPTH} 层`;
    nodes += 1;
    if (nodes > MAX_NODES) return `决策树最多支持 ${MAX_NODES} 个节点`;
    if (typeof node.id !== 'string' || !node.id.trim() || node.id.length > 100 || ids.has(node.id)) return '决策树节点 ID 无效或重复';
    if (active.has(node)) return '决策树不能形成循环引用';
    ids.add(node.id);
    active.add(node);
    if (node.type === 'result') {
      leaves += 1;
      active.delete(node);
      if (leaves > MAX_LEAVES) return `决策树最多支持 ${MAX_LEAVES} 个结果节点`;
      if (node.label != null && (typeof node.label !== 'string' || node.label.length > 80)) return '结果节点名称不能超过 80 个字符';
      if (!Array.isArray(node.actions) || !node.actions.length) return '每个结果节点至少需要一个动作';
      return null;
    }
    if (node.type !== 'condition') return '决策树节点类型无效';
    if (!node.condition || typeof node.condition !== 'object' || Array.isArray(node.condition)) return '条件节点内容无效';
    if (!inverseOperators[node.condition.operator]) return `条件运算符 ${node.condition.operator || '（空）'} 不支持决策树分支`;
    if (!node.trueChild || !node.falseChild) return '条件节点必须同时包含“是”和“否”分支';
    const trueError = visit(node.trueChild, depth + 1);
    if (trueError) return trueError;
    const falseError = visit(node.falseChild, depth + 1);
    active.delete(node);
    return falseError;
  };
  const structureError = visit(tree.root, 1);
  if (structureError) return structureError;

  try {
    const paths = decisionTreePaths(tree);
    for (const [index, path] of paths.entries()) {
      if (path.conditions.length > 20) return `第 ${index + 1} 条路径条件超过 20 个`;
      const rule = {
        name: `${tree.name} / ${path.node.label?.trim() || `结果 ${index + 1}`}`,
        description: tree.description,
        category: tree.category,
        priority: tree.priority,
        conditions: path.conditions.map((condition, position) => ({ ...condition, ...(position ? { connector: 'and' } : {}) })),
        actions: structuredClone(path.node.actions),
      };
      const error = validateRule(rule, bom, variables);
      if (error) return `第 ${index + 1} 条路径：${error}`;
    }
  } catch (error) {
    return error.message;
  }
  return null;
}

function fallbackExecutionKey(tree) {
  let hash = 2166136261;
  for (const character of JSON.stringify([tree.name, tree.root])) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `fallback-${(hash >>> 0).toString(16)}`;
}

export function decisionTreeRules(tree, bom = DEFAULT_BOM, executionKey, variables = []) {
  const error = validateDecisionTree(tree, bom, variables);
  if (error) throw new Error(error);
  const paths = decisionTreePaths(tree);
  const activationGroup = `decision-tree:${executionKey || fallbackExecutionKey(tree)}`;
  return paths.map((path, index) => ({
    name: `${tree.name} / ${path.node.label?.trim() || `结果 ${index + 1}`}`,
    description: tree.description,
    category: tree.category,
    priority: tree.priority,
    salience: tree.priority * TREE_PRIORITY_SCALE + paths.length - index,
    activationGroup,
    decisionTreeLeafId: path.node.id,
    conditions: path.conditions.map((condition, position) => ({ ...condition, ...(position ? { connector: 'and' } : {}) })),
    actions: structuredClone(path.node.actions),
  }));
}

export function decisionTreeDrl(tree, bom = DEFAULT_BOM, executionKey, variables = []) {
  return generateDrl(decisionTreeRules(tree, bom, executionKey, variables), bom, variables);
}

export function decisionTreeExecutionTrace(tree, fired = [], bom = DEFAULT_BOM, variables = []) {
  const generated = decisionTreeRules(tree, bom, undefined, variables);
  return fired.map(name => {
    const generatedIndex = generated.findIndex((rule, index) => name === `${rule.name} [${index + 1}]` || name.startsWith(`${rule.name} [`));
    const rule = generated[generatedIndex];
    return {
      ruleName: name,
      leafId: rule?.decisionTreeLeafId || null,
      leafIndex: generatedIndex >= 0 ? generatedIndex : null,
      label: generatedIndex >= 0 ? decisionTreeLeaves(tree)[generatedIndex]?.label || null : null,
      actions: structuredClone(rule?.actions || []),
    };
  });
}
