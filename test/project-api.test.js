import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { startTestEnv } from './helpers.js';

async function publishProjectRuleset(env, projectId, ruleId, name = '项目业务规则集') {
  const created = await env.request(`/api/projects/${projectId}/flows`, 'POST');
  assert.equal(created.status, 201);
  const saved = await env.request(`/api/projects/${projectId}/flows/${created.body.id}`, 'PUT', {
    revision: created.body.revision,
    draft: {
      ...created.body.draft,
      name,
      steps: [{ type: 'rule', id: ruleId }],
      branches: [],
    },
  });
  assert.equal(saved.status, 200);
  const published = await env.request(`/api/projects/${projectId}/flows/${created.body.id}/publish`, 'POST', {
    revision: saved.body.revision,
  });
  assert.equal(published.status, 200);
  return published.body;
}


test('home activity returns real events with project context', async () => {
  const env = await startTestEnv();
  try {
    const headers = { 'x-actor': 'activity-author' };
    const project = await env.request('/api/projects', 'POST', {
      name: '活动流测试项目', description: '主页活动回归', icon: 'shield', bomTemplate: 'risk',
    }, headers);
    assert.equal(project.status, 201);

    const created = await env.request(`/api/projects/${project.body.id}/rules`, 'POST', {
      type: 'rule', name: '主页活动规则', category: 'activity',
    }, headers);
    assert.equal(created.status, 201);

    const activity = await env.request('/api/activity?limit=10', 'GET', undefined, headers);
    assert.equal(activity.status, 200);
    const event = activity.body.find(item => item.resourceId === created.body.id);
    assert.ok(event);
    assert.equal(event.actor, 'activity-author');
    assert.equal(event.action, 'asset.created');
    assert.equal(event.summary, '创建规则：主页活动规则');
    assert.deepEqual(event.project, { id: project.body.id, name: '活动流测试项目', engine: 'rules' });
    assert.equal((await env.request('/api/activity?limit=1', 'GET', undefined, headers)).body.length, 1);
  } finally {
    await env.stop();
  }
});


test('advanced rule conditions survive project API save and compile unchanged', async () => {
  const env = await startTestEnv();
  try {
    const created = await env.request('/api/projects/default/rules', 'POST', {
      type: 'rule', name: '高级条件往返测试', category: 'advanced',
    });
    assert.equal(created.status, 201);

    const advancedConditions = [
      { field: 'customerAge', operator: '>=', value: '18' },
      { raw: 'creditScore >= customerAge' },
      { pattern: 'not', condition: 'RuleInput( creditScore < 0 )' },
    ];
    const draft = {
      ...created.body.draft,
      name: '高级条件往返测试',
      description: '验证 BAL 编辑器兼容的高级 DRL 条件',
      conditions: structuredClone(advancedConditions),
      actions: [{ field: 'riskLevel', value: '低' }],
    };

    const saved = await env.request(`/api/projects/default/rules/${created.body.id}`, 'PUT', {
      revision: created.body.revision,
      draft,
    });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.body.draft.conditions, advancedConditions);
    assert.equal(saved.body.bomInvalid, false);

    const loaded = await env.request(`/api/projects/default/rules/${created.body.id}`);
    assert.equal(loaded.status, 200);
    assert.deepEqual(loaded.body.draft.conditions, advancedConditions);
    assert.equal(loaded.body.bomInvalid, false);

    const packages = await env.request('/api/projects/default/packages');
    const summary = packages.body.flatMap(pkg => pkg.assets).find(asset => asset.id === created.body.id);
    assert.ok(summary);
    assert.equal(summary.bomInvalid, false);
    assert.equal(summary.bomIssue, undefined);

    const compiled = await env.request(`/api/projects/default/rules/${created.body.id}/compile`, 'POST', {
      revision: loaded.body.revision,
      draft: loaded.body.draft,
    });
    assert.equal(compiled.status, 200);
    assert.match(compiled.body.drl, /not RuleInput\( creditScore < 0 \)/);
    assert.match(compiled.body.drl, /customerAge >= 18, creditScore >= customerAge/);
  } finally {
    await env.stop();
  }
});

test('Rule Project variables are persisted and available to BAL editors', async () => {
  const env = await startTestEnv();
  try {
    const current = await env.request('/api/projects/default');
    assert.equal(current.status, 200);
    const updated = await env.request('/api/projects/default', 'PUT', {
      name: current.body.name,
      description: current.body.description,
      icon: current.body.icon,
      defaultEnvironment: current.body.defaultEnvironment,
      variables: [{ name: 'approved', label: '已批准', type: 'Boolean', defaultValue: false }],
    });
    assert.equal(updated.status, 200);
    assert.deepEqual(updated.body.variables.map(variable => variable.name), ['approved']);
    const reloaded = await env.request('/api/projects/default');
    assert.equal(reloaded.status, 200);
    assert.deepEqual(reloaded.body.variables.map(variable => variable.name), ['approved']);

    const copied = await env.request('/api/projects', 'POST', {
      name: '复制项目变量',
      description: '复制 Rule Project 变量',
      icon: 'shield',
      copyProjectId: 'default',
    });
    assert.equal(copied.status, 201);
    assert.deepEqual(copied.body.variables.map(variable => variable.name), ['approved']);

    const createdProject = await env.request('/api/projects', 'POST', {
      name: '新建变量项目',
      description: '新项目变量保存回归',
      icon: 'shield',
      bomTemplate: 'blank',
    });
    assert.equal(createdProject.status, 201);
    const updatedProject = await env.request(`/api/projects/${createdProject.body.id}`, 'PUT', {
      name: createdProject.body.name,
      description: createdProject.body.description,
      icon: createdProject.body.icon,
      defaultEnvironment: createdProject.body.defaultEnvironment,
      variables: [{ name: 'seenA', label: '见过 A', type: 'Boolean', defaultValue: false }],
    });
    assert.equal(updatedProject.status, 200);
    assert.deepEqual(updatedProject.body.variables.map(variable => variable.name), ['seenA']);
    const reloadedProject = await env.request(`/api/projects/${createdProject.body.id}`);
    assert.equal(reloadedProject.status, 200);
    assert.deepEqual(reloadedProject.body.variables.map(variable => variable.name), ['seenA']);

    const created = await env.request('/api/projects/default/rules', 'POST', {
      type: 'rule', name: '项目变量规则', category: 'variables',
    });
    assert.equal(created.status, 201);
    const draft = {
      ...created.body.draft,
      conditions: [{ fieldSource: 'variable', field: 'approved', operator: '==', value: 'true' }],
      actions: [{ fieldSource: 'variable', field: 'approved', value: 'false' }],
    };
    const saved = await env.request(`/api/projects/default/rules/${created.body.id}`, 'PUT', {
      revision: created.body.revision,
      draft,
    });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.body.projectVariables.map(variable => variable.name), ['approved']);
    assert.match(saved.body.content, /RuleContext/);
    assert.match(saved.body.content, /approved == true/);
    assert.match(saved.body.content, /setApproved\(false\)/);
  } finally {
    await env.stop();
  }
});


test('structured field comparisons survive save, compile, and BOM reference tracking', async () => {
  const env = await startTestEnv();
  try {
    const created = await env.request('/api/projects/default/rules', 'POST', {
      type: 'rule', name: '业务字段比较往返测试', category: 'structured',
    });
    assert.equal(created.status, 201);
    const bomBefore = await env.request('/api/projects/default/bom');
    const referencesBefore = Object.fromEntries(bomBefore.body.vocabulary.map(term => [term.property.split('.').at(-1), term.references]));
    const conditions = [{
      field: 'customerAge', operator: '>=', valueSource: 'field', valueField: 'creditScore', value: '',
    }];
    const draft = {
      ...created.body.draft,
      name: '业务字段比较往返测试',
      description: '验证结构化 BAL 的同类型字段比较',
      conditions: structuredClone(conditions),
      actions: [{ field: 'riskLevel', value: '低' }],
    };

    const saved = await env.request(`/api/projects/default/rules/${created.body.id}`, 'PUT', {
      revision: created.body.revision,
      draft,
    });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.body.draft.conditions, conditions);
    assert.equal(saved.body.bomInvalid, false);

    const loaded = await env.request(`/api/projects/default/rules/${created.body.id}`);
    assert.deepEqual(loaded.body.draft.conditions, conditions);
    const compiled = await env.request(`/api/projects/default/rules/${created.body.id}/compile`, 'POST', {
      revision: loaded.body.revision,
      draft: loaded.body.draft,
    });
    assert.equal(compiled.status, 200);
    assert.match(compiled.body.drl, /customerAge >= creditScore/);
    assert.doesNotMatch(compiled.body.drl, /customerAge >= "creditScore"/);

    const bomAfter = await env.request('/api/projects/default/bom');
    const creditScore = bomAfter.body.vocabulary.find(term => term.property.endsWith('.creditScore'));
    assert.equal(creditScore.references, referencesBefore.creditScore + 1);
    const references = await env.request('/api/projects/default/bom/references?field=creditScore');
    assert.ok(references.body.some(item => item.id === created.body.id && item.type === 'rule'));

    const rawBom = JSON.parse(await fs.readFile(path.join(env.dir, 'bom.json'), 'utf8'));
    const blocked = await env.request('/api/projects/default/bom', 'PUT', {
      version: rawBom.version,
      fields: rawBom.fields.filter(field => field.key !== 'creditScore'),
    });
    assert.equal(blocked.status, 400);
    assert.match(blocked.body.error, /信用评分.*不能删除/);
  } finally {
    await env.stop();
  }
});


test('extended BAL operator values survive project API save and compile', async () => {
  const env = await startTestEnv();
  try {
    const created = await env.request('/api/projects/default/rules', 'POST', {
      type: 'rule', name: '扩展操作符往返测试', category: 'structured',
    });
    assert.equal(created.status, 201);
    const conditions = [
      { field: 'customerAge', operator: 'between', value: '18', valueEnd: '65' },
      { field: 'customerType', operator: 'in', value: '', values: ['个人', '企业'], connector: 'and' },
    ];
    const draft = {
      ...created.body.draft,
      name: '扩展操作符往返测试',
      conditions: structuredClone(conditions),
      actions: [{ field: 'riskLevel', value: '低' }],
    };

    const saved = await env.request(`/api/projects/default/rules/${created.body.id}`, 'PUT', {
      revision: created.body.revision,
      draft,
    });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.body.draft.conditions, conditions);
    assert.match(saved.body.content, /customerAge >= 18 && customerAge <= 65/);
    assert.match(saved.body.content, /customerType in \("个人", "企业"\)/);

    const loaded = await env.request(`/api/projects/default/rules/${created.body.id}`);
    assert.deepEqual(loaded.body.draft.conditions, conditions);
    const compiled = await env.request(`/api/projects/default/rules/${created.body.id}/compile`, 'POST', {
      revision: loaded.body.revision,
      draft: loaded.body.draft,
    });
    assert.equal(compiled.status, 200);
    assert.match(compiled.body.drl, /customerAge >= 18 && customerAge <= 65/);
    assert.match(compiled.body.drl, /customerType in \("个人", "企业"\)/);
  } finally {
    await env.stop();
  }
});


test('project engine defaults to rules and locks after creation', async () => {
  const env = await startTestEnv();
  try {
    const invalid = await env.request('/api/projects', 'POST', {
      name: '非法引擎项目', description: '', icon: 'shield', engine: 'invalid', bomTemplate: 'blank',
    });
    assert.equal(invalid.status, 400);

    const rulesProject = await env.request('/api/projects', 'POST', {
      name: '默认规则引擎项目', description: 'engine 默认值回归', icon: 'shield', bomTemplate: 'blank',
    });
    assert.equal(rulesProject.status, 201);
    assert.equal(rulesProject.body.engine, 'rules');

    const cepProject = await env.request('/api/projects', 'POST', {
      name: '传感器 CEP 项目', description: '事件流监控', icon: 'warehouse', engine: 'cep', bomTemplate: 'grain',
    });
    assert.equal(cepProject.status, 201);
    assert.equal(cepProject.body.engine, 'cep');

    const listed = await env.request('/api/projects');
    assert.equal(listed.status, 200);
    assert.equal(listed.body.find(project => project.id === cepProject.body.id)?.engine, 'cep');
    assert.equal(listed.body.find(project => project.id === 'default')?.engine, 'rules');

    const loaded = await env.request(`/api/projects/${cepProject.body.id}`);
    assert.equal(loaded.status, 200);
    assert.equal(loaded.body.engine, 'cep');

    const cepBom = await env.request(`/api/projects/${cepProject.body.id}/bom`);
    assert.equal(cepBom.status, 200);
    assert.equal(cepBom.body.eventTypes[0].name, 'GrainStore');
    assert.equal(cepBom.body.eventTypes[0].keyField, 'warehouseId');

    const sameEngineUpdate = await env.request(`/api/projects/${cepProject.body.id}`, 'PUT', {
      name: cepProject.body.name, description: '只允许改元信息', icon: 'warehouse', engine: 'cep',
    });
    assert.equal(sameEngineUpdate.status, 200);
    assert.equal(sameEngineUpdate.body.engine, 'cep');

    const engineChange = await env.request(`/api/projects/${cepProject.body.id}`, 'PUT', {
      name: cepProject.body.name, description: '尝试改引擎', icon: 'warehouse', engine: 'rules',
    });
    assert.equal(engineChange.status, 400);
    assert.match(engineChange.body.error, /引擎创建后不可修改/);

    assert.equal((await env.request(`/api/projects/${cepProject.body.id}/rules`)).status, 404);
    assert.equal((await env.request(`/api/projects/${cepProject.body.id}/rules`, 'POST', {
      type: 'rule', name: '非法规则资产', category: 'default',
    })).status, 403);
    assert.equal((await env.request(`/api/projects/${cepProject.body.id}/tables`)).status, 404);
    assert.equal((await env.request(`/api/projects/${cepProject.body.id}/flows`)).status, 404);
    assert.equal((await env.request(`/api/projects/${rulesProject.body.id}/event-streams`)).status, 404);
    assert.equal((await env.request(`/api/projects/${rulesProject.body.id}/event-streams`, 'POST', {
      name: '非法事件流', statements: [{ name: 'DetectEvent', epl: 'select * from GrainStore' }],
    })).status, 403);
  } finally {
    await env.stop();
  }
});

test('project and package CRUD keeps assets and hierarchy consistent', async () => {
  const env = await startTestEnv();
  try {
    const created = await env.request('/api/projects', 'POST', {
      name: '小微企业贷款审批', description: '项目 CRUD 回归', icon: 'loan', bomTemplate: 'risk',
    });
    assert.equal(created.status, 201);
    assert.match(created.body.id, /^project-/);
    assert.equal(created.body.name, '小微企业贷款审批');

    const projectId = created.body.id;
    const rootPackage = await env.request(`/api/projects/${projectId}/packages`, 'POST', {
      name: 'eligibility', label: '准入', parentId: null,
    });
    assert.equal(rootPackage.status, 201);
    const childPackage = await env.request(`/api/projects/${projectId}/packages`, 'POST', {
      name: 'income', label: '收入核查', parentId: 'eligibility',
    });
    assert.equal(childPackage.status, 201);
    assert.equal(childPackage.body.name, 'eligibility.income');
    const concurrentPackages = await Promise.all([
      env.request(`/api/projects/${projectId}/packages`, 'POST', { name: 'documents', label: '材料核查', parentId: 'eligibility' }),
      env.request(`/api/projects/${projectId}/packages`, 'POST', { name: 'history', label: '历史核查', parentId: 'eligibility' }),
    ]);
    assert.deepEqual(concurrentPackages.map(response => response.status), [201, 201]);
    const packageNames = (await env.request(`/api/projects/${projectId}/packages`)).body.map(pkg => pkg.name);
    assert.ok(packageNames.includes('eligibility.documents'));
    assert.ok(packageNames.includes('eligibility.history'));
    assert.equal((await env.request(`/api/projects/${projectId}/packages`, 'POST', { name: '中文包', label: '无效', parentId: null })).status, 400);

    const rule = await env.request(`/api/projects/${projectId}/rules`, 'POST', {
      type: 'rule', name: '客户收入准入', category: 'eligibility.income',
    });
    assert.equal(rule.status, 201);
    assert.equal(rule.body.draft.name, '客户收入准入');
    assert.equal(rule.body.draft.category, 'eligibility.income');
    assert.equal(rule.body.bomInvalid, false);

    const renamedRule = await env.request(`/api/projects/${projectId}/rules/${rule.body.id}/rename`, 'POST', {
      revision: rule.body.revision,
      newName: '客户收入准入（已重命名）',
    });
    assert.equal(renamedRule.status, 200);
    assert.equal(renamedRule.body.draft.name, '客户收入准入（已重命名）');
    assert.equal(renamedRule.body.revision, 2);
    assert.equal((await env.request(`/api/projects/${projectId}/rules/${rule.body.id}/rename`, 'POST', { revision: 1, newName: '过期重命名' })).status, 409);

    const duplicate = await env.request(`/api/projects/${projectId}/rules/${rule.body.id}/duplicate`, 'POST', { newName: '客户收入准入副本' });
    assert.equal(duplicate.status, 201);
    assert.equal(duplicate.body.status, 'draft');
    assert.equal(duplicate.body.draft.name, '客户收入准入副本');

    const renamed = await env.request(`/api/projects/${projectId}/packages/eligibility.income`, 'PUT', {
      name: 'credit', label: '信用核查', parentId: 'eligibility',
    });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.id, 'eligibility.credit');
    const movedByRename = await env.request(`/api/projects/${projectId}/rules/${rule.body.id}`);
    assert.equal(movedByRename.body.draft.category, 'eligibility.credit');

    const protectedDelete = await env.request(`/api/projects/${projectId}/packages/eligibility.credit`, 'DELETE', {});
    assert.equal(protectedDelete.status, 409);
    assert.equal(protectedDelete.body.assetCount, 2);
    const deletedPackage = await env.request(`/api/projects/${projectId}/packages/eligibility.credit`, 'DELETE', { moveRulesTo: 'eligibility' });
    assert.equal(deletedPackage.status, 204);
    assert.equal((await env.request(`/api/projects/${projectId}/rules/${rule.body.id}`)).body.draft.category, 'eligibility');

    const archived = await env.request(`/api/projects/${projectId}/archive`, 'POST');
    assert.equal(archived.status, 200);
    assert.equal(archived.body.archived, true);
    assert.equal((await env.request('/api/projects')).body.some(project => project.id === projectId), false);
    assert.equal((await env.request('/api/projects?archived=true')).body.some(project => project.id === projectId && project.archived), true);
    assert.equal((await env.request(`/api/projects/${projectId}`, 'DELETE')).status, 204);
    assert.equal((await env.request(`/api/projects/${projectId}`)).status, 404);
  } finally {
    await env.stop();
  }
});

test('project decision-table API creates, analyzes, and compiles cell comparison syntax', async () => {
  const env = await startTestEnv();
  try {
    const created = await env.request('/api/projects/default/rules', 'POST', {
      type: 'decision-table',
      category: '定价',
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.type, 'decision-table');
    assert.equal(created.body.packageName, 'pricing');
    assert.equal(created.body.revision, 1);
    assert.equal(created.body.bomInvalid, false);

    const draft = structuredClone(created.body.draft);
    draft.name = '信用评分分段';
    draft.conditions = [{ field: 'creditScore', operator: '<' }];
    draft.actions = [{ field: 'riskLevel' }];
    draft.rows = [
      { enabled: true, conditions: ['<600'], actions: ['高'] },
      { enabled: true, conditions: ['>=600'], actions: ['低'] },
    ];

    const analysis = await env.request(`/api/projects/default/rules/${created.body.id}/analyze`, 'POST', {
      revision: created.body.revision,
      draft,
    });
    assert.equal(analysis.status, 200);
    assert.equal(analysis.body.error, null);
    assert.deepEqual(analysis.body.warnings, []);
    assert.match(analysis.body.drl, /creditScore < 600/);
    assert.match(analysis.body.drl, /creditScore >= 600/);

    const compiled = await env.request(`/api/projects/default/rules/${created.body.id}/compile`, 'POST', {
      revision: created.body.revision,
      draft,
    });
    assert.equal(compiled.status, 200);
    assert.equal(compiled.body.engineVersion, '10.2.0');
    assert.match(compiled.body.drl, /信用评分分段 第2行/);
  } finally {
    await env.stop();
  }
});

test('project decision-table API persists and compiles Rule Project variable columns', async () => {
  const env = await startTestEnv();
  try {
    const current = await env.request('/api/projects/default');
    assert.equal(current.status, 200);
    const updated = await env.request('/api/projects/default', 'PUT', {
      name: current.body.name,
      description: current.body.description,
      icon: current.body.icon,
      defaultEnvironment: current.body.defaultEnvironment,
      variables: [{ name: 'approved', label: '已批准', type: 'Boolean', defaultValue: false }],
    });
    assert.equal(updated.status, 200);

    const created = await env.request('/api/projects/default/rules', 'POST', {
      type: 'decision-table',
      name: '变量决策表',
      category: 'variables',
    });
    assert.equal(created.status, 201);

    const draft = {
      ...created.body.draft,
      conditions: [{ field: 'approved', fieldSource: 'variable', operator: '==' }],
      actions: [{ field: 'approved', fieldSource: 'variable' }],
      rows: [{ enabled: true, priority: 0, conditions: ['true'], actions: ['false'] }],
    };
    const saved = await env.request(`/api/projects/default/rules/${created.body.id}`, 'PUT', {
      revision: created.body.revision,
      draft,
    });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.body.draft.conditions, draft.conditions);
    assert.deepEqual(saved.body.draft.actions, draft.actions);
    assert.deepEqual(saved.body.projectVariables.map(variable => variable.name), ['approved']);
    assert.match(saved.body.content, /RuleContext/);
    assert.match(saved.body.content, /approved == true/);
    assert.match(saved.body.content, /setApproved\(false\)/);

    const analysis = await env.request(`/api/projects/default/rules/${created.body.id}/analyze`, 'POST', {
      revision: saved.body.revision,
      draft: saved.body.draft,
    });
    assert.equal(analysis.status, 200);
    assert.equal(analysis.body.error, null);
    assert.match(analysis.body.drl, /RuleContext/);

    const compiled = await env.request(`/api/projects/default/rules/${created.body.id}/compile`, 'POST', {
      revision: saved.body.revision,
      draft: saved.body.draft,
    });
    assert.equal(compiled.status, 200);
    assert.match(compiled.body.drl, /setApproved\(false\)/);

    const published = await env.request(`/api/projects/default/rules/${created.body.id}/publish`, 'POST', {
      revision: saved.body.revision,
    });
    assert.equal(published.status, 200);
    assert.match(published.body.content, /declare RuleContext/);

    const invalid = await env.request(`/api/projects/default/rules/${created.body.id}/compile`, 'POST', {
      revision: published.body.revision,
      draft: {
        ...published.body.draft,
        conditions: [{ field: 'missingVariable', fieldSource: 'variable', operator: '==', }],
      },
    });
    assert.equal(invalid.status, 400);
    assert.match(invalid.body.error, /条件列字段重复或比较方式无效|不存在|无效/);
  } finally {
    await env.stop();
  }
});

test('project compatibility API exposes the default workspace without duplicating assets', async () => {
  const env = await startTestEnv();
  try {
    const created = (await env.request('/api/rules', 'POST')).body;
    await env.request(`/api/rules/${created.id}`, 'PUT', {
      ...created.draft,
      name: '项目 API 规则',
      category: '准入',
    });
    await env.request(`/api/rules/${created.id}/publish`, 'POST');
    const table = (await env.request('/api/tables', 'POST')).body;

    const projects = await env.request('/api/projects');
    assert.equal(projects.status, 200);
    assert.equal(projects.body.length, 1);
    assert.equal(projects.body[0].id, 'default');
    assert.equal(projects.body[0].source, 'server');
    assert.equal(projects.body[0].assetCount, 3);

    const packages = await env.request('/api/projects/default/packages');
    assert.equal(packages.status, 200);
    assert.deepEqual(packages.body.map(item => item.id).sort(), ['common', 'credit_risk', 'eligibility']);
    assert.equal(packages.body.flatMap(item => item.assets).length, 3);

    const ruleDetail = await env.request(`/api/projects/default/rules/${created.id}`);
    assert.equal(ruleDetail.status, 200);
    assert.equal(ruleDetail.body.type, 'rule');
    assert.match(ruleDetail.body.content, /项目 API 规则/);
    assert.equal(ruleDetail.body.revision, 3);
    assert.equal(ruleDetail.body.draft.name, '项目 API 规则');

    const savedRule = await env.request(`/api/projects/default/rules/${created.id}`, 'PUT', {
      revision: ruleDetail.body.revision,
      draft: { ...ruleDetail.body.draft, name: '项目 API 已保存规则' },
    });
    assert.equal(savedRule.status, 200);
    assert.equal(savedRule.body.revision, 4);
    assert.equal(savedRule.body.draft.name, '项目 API 已保存规则');
    const compiledRule = await env.request(`/api/projects/default/rules/${created.id}/compile`, 'POST', {
      revision: savedRule.body.revision,
      draft: savedRule.body.draft,
    });
    assert.equal(compiledRule.status, 200);
    assert.equal(compiledRule.body.engineVersion, '10.2.0');
    assert.match(compiledRule.body.drl, /项目 API 已保存规则/);
    const publishedRule = await env.request(`/api/projects/default/rules/${created.id}/publish`, 'POST', {
      revision: savedRule.body.revision,
    });
    assert.equal(publishedRule.status, 200);
    assert.equal(publishedRule.body.revision, 5);
    assert.equal(publishedRule.body.version, '2');
    const staleRule = await env.request(`/api/projects/default/rules/${created.id}`, 'PUT', {
      revision: savedRule.body.revision,
      draft: savedRule.body.draft,
    });
    assert.equal(staleRule.status, 409);
    assert.equal(staleRule.body.currentRevision, 5);

    const tableDetail = await env.request(`/api/projects/default/rules/${table.id}`);
    assert.equal(tableDetail.status, 200);
    assert.equal(tableDetail.body.type, 'decision-table');
    assert.equal(tableDetail.body.decisionTable.rows.length, 2);
    assert.equal(tableDetail.body.decisionTable.columns.length, 4);
    assert.equal(tableDetail.body.decisionTable.hitPolicy, 'COLLECT');
    const compiledTable = await env.request(`/api/projects/default/rules/${table.id}/compile`, 'POST', {
      revision: tableDetail.body.revision,
      draft: tableDetail.body.draft,
    });
    assert.equal(compiledTable.status, 200);
    assert.match(compiledTable.body.drl, /未命名决策表 第1行/);
    const publishedTable = await env.request(`/api/projects/default/rules/${table.id}/publish`, 'POST', {
      revision: tableDetail.body.revision,
    });
    assert.equal(publishedTable.status, 200);
    assert.equal(publishedTable.body.status, 'published');

    const createdFlow = await env.request('/api/projects/default/flows', 'POST');
    assert.equal(createdFlow.status, 201);
    assert.equal(createdFlow.body.revision, 1);
    assert.ok(createdFlow.body.availableAssets.some(asset => asset.id === created.id && asset.type === 'rule'));
    assert.ok(createdFlow.body.availableAssets.some(asset => asset.id === table.id && asset.type === 'table'));
    assert.deepEqual(createdFlow.body.availableAssets.find(asset => asset.id === created.id).outputFields, ['riskLevel']);
    assert.deepEqual(createdFlow.body.availableAssets.find(asset => asset.id === table.id).outputFields, ['riskLevel', 'reviewRequired']);
    const savedFlow = await env.request(`/api/projects/default/flows/${createdFlow.body.id}`, 'PUT', {
      revision: createdFlow.body.revision,
      draft: {
        ...createdFlow.body.draft,
        name: '项目 API 规则集',
        description: '先规则后决策表',
        steps: [{ type: 'rule', id: created.id }],
        branches: [
          { id: 'high-risk', name: '高风险路径', default: false, condition: { field: 'creditScore', operator: '<', value: '600' }, steps: [{ type: 'table', id: table.id }] },
          { id: 'fallback', name: '默认路径', default: true, steps: [{ type: 'rule', id: created.id }] },
        ],
      },
    });
    assert.equal(savedFlow.status, 200);
    assert.equal(savedFlow.body.revision, 2);
    const compiledFlow = await env.request(`/api/projects/default/flows/${createdFlow.body.id}/compile`, 'POST', {
      revision: savedFlow.body.revision,
      draft: savedFlow.body.draft,
    });
    assert.equal(compiledFlow.status, 200);
    assert.equal(compiledFlow.body.engineVersion, '10.2.0');
    assert.equal(compiledFlow.body.stepCount, 3);
    assert.equal(compiledFlow.body.branchCount, 2);
    const publishedFlow = await env.request(`/api/projects/default/flows/${createdFlow.body.id}/publish`, 'POST', {
      revision: savedFlow.body.revision,
    });
    assert.equal(publishedFlow.status, 200);
    assert.equal(publishedFlow.body.status, 'published');
    assert.equal(publishedFlow.body.version, 1);
    const rulesets = await env.request('/api/projects/default/rulesets');
    assert.equal(rulesets.status, 200);
    assert.equal(rulesets.body.length, 1);
    assert.equal(rulesets.body[0].flowName, '项目 API 规则集');
    assert.equal(rulesets.body[0].needsRepublish, false);

    const latestRule = await env.request(`/api/projects/default/rules/${created.id}`);
    const nextRule = await env.request(`/api/projects/default/rules/${created.id}`, 'PUT', {
      revision: latestRule.body.revision,
      draft: { ...latestRule.body.draft, description: '依赖资产第三版' },
    });
    assert.equal(nextRule.status, 200);
    assert.equal((await env.request(`/api/projects/default/rules/${created.id}/publish`, 'POST', {
      revision: nextRule.body.revision,
    })).status, 200);
    const outdatedRuleset = (await env.request('/api/projects/default/rulesets')).body[0];
    assert.equal(outdatedRuleset.needsRepublish, true);
    assert.deepEqual(outdatedRuleset.outdatedDependencies, [{
      id: created.id,
      name: '项目 API 已保存规则',
      publishedVersion: 2,
      latestVersion: 3,
    }]);
    const staleFlow = await env.request(`/api/projects/default/flows/${createdFlow.body.id}`, 'PUT', {
      revision: savedFlow.body.revision,
      draft: savedFlow.body.draft,
    });
    assert.equal(staleFlow.status, 409);
    assert.equal(staleFlow.body.currentRevision, 3);
    const republishedFlow = await env.request(`/api/projects/default/flows/${createdFlow.body.id}/publish`, 'POST', {
      revision: publishedFlow.body.revision,
    });
    assert.equal(republishedFlow.status, 200);
    assert.equal(republishedFlow.body.needsRepublish, false);

    const suite = await env.request('/api/test-suites', 'POST', {
      name: '项目 API 回归', description: '', target: { type: 'rule', id: created.id }, required: true,
      cases: [{
        id: 'project-case', name: '项目规则场景', enabled: true, facts: { customerAge: 30 },
        expected: { outputs: { riskLevel: '中' }, fired: ['mock 规则 [1]'] },
      }],
    });
    assert.equal(suite.status, 201);
    const projectSuites = await env.request('/api/projects/default/tests');
    assert.equal(projectSuites.status, 200);
    assert.equal(projectSuites.body.length, 1);
    assert.equal(projectSuites.body[0].targetName, '项目 API 已保存规则');
    const suiteRun = await env.request(`/api/projects/default/tests/${suite.body.id}/run`, 'POST');
    assert.equal(suiteRun.status, 200);
    assert.equal(suiteRun.body.report.passed, true);
    assert.equal(suiteRun.body.suite.lastRun.id, suiteRun.body.report.id);
    const allRuns = await env.request('/api/projects/default/tests/run', 'POST');
    assert.equal(allRuns.status, 200);
    assert.equal(allRuns.body.total, 1);
    assert.equal(allRuns.body.passedCount, 1);

    const release = await env.request('/api/projects/default/releases', 'POST', {
      decisionService: 'default/project-api', name: '项目 API Release', description: '项目级发布兼容接口',
      target: { type: 'rule', id: created.id },
    });
    assert.equal(release.status, 400);
    assert.match(release.body.error, /必须以规则集为发布目标/);
    const projectReleases = await env.request('/api/projects/default/releases');
    assert.equal(projectReleases.status, 200);
    assert.equal(projectReleases.body.length, 0);

    const flowRelease = await env.request('/api/projects/default/releases', 'POST', {
      decisionService: 'default/project-flow', name: '项目规则集 Release', description: '项目级规则集发布',
      target: { type: 'flow', id: createdFlow.body.id },
    });
    assert.equal(flowRelease.status, 201);
    assert.equal(flowRelease.body.target.type, 'flow');
    assert.equal(flowRelease.body.steps.length, 3);

    const bom = await env.request('/api/projects/default/bom');
    assert.equal(bom.status, 200);
    assert.equal(bom.body.version, 1);
    assert.equal(bom.body.updatedBy, 'Team Server');
    assert.equal(bom.body.factTypes.length, 2);
    assert.equal(bom.body.factTypes[0].name, 'Borrower');
    assert.equal(bom.body.factTypes[0].direction, 'input');
    assert.equal(bom.body.factTypes.reduce((count, fact) => count + fact.fields.length, 0), 8);
    assert.ok(bom.body.vocabulary.some(term => term.property === 'Borrower.customerAge' && term.references > 0));
    assert.match(bom.body.drl, /declare RuleInput/);

    assert.equal((await env.request('/api/projects/missing')).status, 404);
    const createdPackage = await env.request('/api/projects/default/packages', 'POST', { name: 'collections', label: '催收', parentId: null });
    assert.equal(createdPackage.status, 201);
    assert.equal(createdPackage.body.name, 'collections');
  } finally {
    await env.stop();
  }
});

test('project approval workflow locks submitted assets and publishes the pinned revision', async () => {
  const env = await startTestEnv();
  try {
    const project = (await env.request('/api/projects', 'POST', {
      name: '项目审核回归', description: '项目级变更集', icon: 'shield', bomTemplate: 'risk',
    })).body;
    await env.request(`/api/projects/${project.id}/packages`, 'POST', {
      name: 'eligibility', label: '准入', parentId: null,
    });
    const created = (await env.request(`/api/projects/${project.id}/rules`, 'POST', {
      type: 'rule', name: '年龄准入审核', category: 'eligibility',
    })).body;
    const draft = structuredClone(created.draft);
    draft.conditions[0].value = '18';
    draft.actions[0].value = '低';
    const saved = await env.request(`/api/projects/${project.id}/rules/${created.id}`, 'PUT', {
      revision: created.revision, draft,
    });
    assert.equal(saved.status, 200);

    const submitted = await env.request(`/api/projects/${project.id}/rules/${created.id}/submit`, 'POST', {
      revision: saved.body.revision,
    }, { 'x-actor': 'author-a' });
    assert.equal(submitted.status, 201);
    assert.equal(submitted.body.status, 'in-review');
    assert.ok(submitted.body.changeSetId);

    const changeSets = await env.request(`/api/projects/${project.id}/change-sets`);
    assert.equal(changeSets.status, 200);
    assert.equal(changeSets.body.length, 1);
    assert.equal(changeSets.body[0].status, 'SUBMITTED');
    assert.equal(changeSets.body[0].createdBy, 'author-a');
    assert.equal(changeSets.body[0].items[0].assetRevision, saved.body.revision);
    assert.equal((await env.request('/api/change-sets')).body.some(item => item.id === submitted.body.changeSetId), false);

    const lockedDraft = { ...draft, description: '审核中不允许保存' };
    assert.equal((await env.request(`/api/projects/${project.id}/rules/${created.id}`, 'PUT', {
      revision: saved.body.revision, draft: lockedDraft,
    })).status, 409);
    assert.equal((await env.request(`/api/projects/${project.id}/rules/${created.id}/rename`, 'POST', {
      revision: saved.body.revision, newName: '审核中重命名',
    })).status, 409);
    assert.equal((await env.request(`/api/projects/${project.id}/rules/${created.id}/move`, 'POST', {
      targetPackage: 'eligibility',
    })).status, 409);
    assert.equal((await env.request(`/api/projects/${project.id}/rules/${created.id}`, 'DELETE', {})).status, 409);
    assert.equal((await env.request(`/api/projects/${project.id}/packages/eligibility`, 'PUT', {
      name: 'credit', label: '信用', parentId: null,
    })).status, 409);

    const invalidReject = await env.request(`/api/projects/${project.id}/change-sets/${submitted.body.changeSetId}/reject`, 'POST', {
      revision: changeSets.body[0].revision,
    });
    assert.equal(invalidReject.status, 400);
    const rejected = await env.request(`/api/projects/${project.id}/change-sets/${submitted.body.changeSetId}/reject`, 'POST', {
      revision: changeSets.body[0].revision, comment: '请补充依据',
    });
    assert.equal(rejected.status, 200);
    assert.equal(rejected.body.status, 'REJECTED');
    assert.equal((await env.request(`/api/projects/${project.id}/rules/${created.id}`)).body.status, 'rejected');

    const revised = await env.request(`/api/projects/${project.id}/rules/${created.id}`, 'PUT', {
      revision: saved.body.revision, draft: { ...draft, description: '已补充年龄政策依据' },
    });
    assert.equal(revised.status, 200);
    assert.equal(revised.body.status, 'draft');
    const resubmitted = await env.request(`/api/projects/${project.id}/rules/${created.id}/submit`, 'POST', {
      revision: revised.body.revision,
    }, { 'x-actor': 'author-a' });
    assert.equal(resubmitted.status, 201);

    const review = (await env.request(`/api/projects/${project.id}/change-sets/${resubmitted.body.changeSetId}`)).body;
    const staleApproval = await env.request(`/api/projects/${project.id}/change-sets/${review.id}/approve`, 'POST', {
      revision: review.revision + 1, comment: '错误修订',
    });
    assert.equal(staleApproval.status, 409);
    const approved = await env.request(`/api/projects/${project.id}/change-sets/${review.id}/approve`, 'POST', {
      revision: review.revision, comment: '审核通过',
    }, { 'x-actor': 'reviewer-a' });
    assert.equal(approved.status, 200);
    assert.equal(approved.body.status, 'APPROVED');
    assert.equal(approved.body.decisionComment, '审核通过');

    const published = await env.request(`/api/projects/${project.id}/rules/${created.id}`);
    assert.equal(published.body.status, 'published');
    assert.equal(published.body.revision, revised.body.revision + 1);
    assert.equal(published.body.version, '1');
    assert.equal(published.body.draft.description, '已补充年龄政策依据');
    const audit = await env.request(`/api/projects/${project.id}/audit-events?limit=20`);
    assert.equal(audit.status, 200);
    assert.ok(audit.body.some(event => event.action === 'change-set.approve'));
    assert.ok(audit.body.every(event => event.projectId == null || event.projectId === project.id));

    const concurrentAsset = (await env.request(`/api/projects/${project.id}/rules/${created.id}/duplicate`, 'POST', {
      newName: '并发审批资产',
    })).body;
    const concurrentSubmit = (await env.request(`/api/projects/${project.id}/rules/${concurrentAsset.id}/submit`, 'POST', {
      revision: concurrentAsset.revision,
    })).body;
    const concurrentSet = (await env.request(`/api/projects/${project.id}/change-sets/${concurrentSubmit.changeSetId}`)).body;
    const concurrentDecisions = await Promise.all([
      env.request(`/api/projects/${project.id}/change-sets/${concurrentSet.id}/approve`, 'POST', { revision: concurrentSet.revision, comment: '批准' }),
      env.request(`/api/projects/${project.id}/change-sets/${concurrentSet.id}/reject`, 'POST', { revision: concurrentSet.revision, comment: '驳回' }),
    ]);
    assert.deepEqual(concurrentDecisions.map(response => response.status).sort(), [200, 409]);
    const concurrentDetail = await env.request(`/api/projects/${project.id}/rules/${concurrentAsset.id}`);
    const winningStatus = concurrentDecisions.find(response => response.status === 200).body.status;
    assert.equal(concurrentDetail.body.status, winningStatus === 'APPROVED' ? 'published' : 'rejected');
  } finally {
    await env.stop();
  }
});

test('project approval policy requires distinct reviewers and freezes policy on submission', async () => {
  const env = await startTestEnv();
  try {
    const project = (await env.request('/api/projects', 'POST', {
      name: '双人审核项目', description: '验证职责分离', icon: 'shield', bomTemplate: 'risk',
    })).body;
    const configured = await env.request(`/api/projects/${project.id}`, 'PUT', {
      name: project.name, description: project.description, icon: project.icon,
      defaultEnvironment: project.defaultEnvironment, variables: [],
      approvalPolicy: {
        requiredApprovals: 2, requireComment: true, preventSelfApproval: true,
        allowedReviewerRoles: ['reviewer', 'admin'],
      },
    });
    assert.equal(configured.status, 200);
    assert.equal(configured.body.approvalPolicy.requiredApprovals, 2);

    await env.request(`/api/projects/${project.id}/packages`, 'POST', {
      name: 'eligibility', label: '准入', parentId: null,
    });
    const createdResponse = await env.request(`/api/projects/${project.id}/rules`, 'POST', {
      type: 'rule', name: '双人审核规则', category: 'eligibility',
    });
    assert.equal(createdResponse.status, 201);
    const created = createdResponse.body;
    const draft = structuredClone(created.draft);
    draft.description = '需要双人审核的规则变更';
    draft.conditions[0].value = '18';
    draft.actions[0].value = '低';
    const saved = await env.request(`/api/projects/${project.id}/rules/${created.id}`, 'PUT', {
      revision: created.revision, draft,
    });
    assert.equal(saved.status, 200);
    const submittedAsset = await env.request(`/api/projects/${project.id}/rules/${created.id}/submit`, 'POST', {
      revision: saved.body.revision,
    }, { 'x-actor': 'author-a' });
    assert.equal(submittedAsset.status, 201);
    const changeSetId = submittedAsset.body.changeSetId;
    const submitted = (await env.request(`/api/projects/${project.id}/change-sets/${changeSetId}`)).body;
    assert.equal(submitted.reviewPolicySnapshot.requiredApprovals, 2);

    const changedPolicy = await env.request(`/api/projects/${project.id}`, 'PUT', {
      name: project.name, description: project.description, icon: project.icon,
      defaultEnvironment: project.defaultEnvironment, variables: [],
      approvalPolicy: {
        requiredApprovals: 1, requireComment: false, preventSelfApproval: false,
        allowedReviewerRoles: ['admin'],
      },
    });
    assert.equal(changedPolicy.status, 200);

    const missingComment = await env.request(`/api/projects/${project.id}/change-sets/${changeSetId}/approve`, 'POST', {
      revision: submitted.revision,
    }, { 'x-actor': 'reviewer-a' });
    assert.equal(missingComment.status, 400);

    const first = await env.request(`/api/projects/${project.id}/change-sets/${changeSetId}/approve`, 'POST', {
      revision: submitted.revision, comment: '一审通过',
    }, { 'x-actor': 'reviewer-a' });
    assert.equal(first.status, 200);
    assert.equal(first.body.status, 'SUBMITTED');
    assert.equal(first.body.approvals.length, 1);
    assert.equal(first.body.reviewPolicySnapshot.requiredApprovals, 2);
    assert.equal((await env.request(`/api/projects/${project.id}/rules/${created.id}`)).body.status, 'in-review');

    const duplicate = await env.request(`/api/projects/${project.id}/change-sets/${changeSetId}/approve`, 'POST', {
      revision: first.body.revision, comment: '重复批准',
    }, { 'x-actor': 'reviewer-a' });
    assert.equal(duplicate.status, 409);

    const second = await env.request(`/api/projects/${project.id}/change-sets/${changeSetId}/approve`, 'POST', {
      revision: first.body.revision, comment: '二审通过',
    }, { 'x-actor': 'reviewer-b' });
    assert.equal(second.status, 200);
    assert.equal(second.body.status, 'APPROVED');
    assert.deepEqual(second.body.approvals.map(approval => approval.actor), ['reviewer-a', 'reviewer-b']);
    assert.equal((await env.request(`/api/projects/${project.id}/rules/${created.id}`)).body.status, 'published');
  } finally {
    await env.stop();
  }
});

test('project Release builds, deploys, executes, and stays isolated from other projects', async () => {
  const env = await startTestEnv();
  try {
    const project = (await env.request('/api/projects', 'POST', {
      name: '项目发布回归', description: '项目级 Release 隔离', icon: 'shield', bomTemplate: 'risk',
    })).body;
    const otherProject = (await env.request('/api/projects', 'POST', {
      name: '其他发布项目', description: '验证跨项目隔离', icon: 'shield', bomTemplate: 'risk',
    })).body;
    await env.request(`/api/projects/${project.id}/packages`, 'POST', {
      name: 'eligibility', label: '准入', parentId: null,
    });
    const created = (await env.request(`/api/projects/${project.id}/rules`, 'POST', {
      type: 'rule', name: '项目年龄准入', category: 'eligibility',
    })).body;
    const draft = structuredClone(created.draft);
    draft.conditions[0].value = '18';
    draft.actions[0].value = '低';
    const saved = await env.request(`/api/projects/${project.id}/rules/${created.id}`, 'PUT', {
      revision: created.revision, draft,
    });
    assert.equal(saved.status, 200);
    const published = await env.request(`/api/projects/${project.id}/rules/${created.id}/publish`, 'POST', {
      revision: saved.body.revision,
    });
    assert.equal(published.status, 200);
    assert.equal(published.body.status, 'published');
    const ruleset = await publishProjectRuleset(env, project.id, created.id, '项目年龄准入规则集');

    const invalidNamespace = await env.request(`/api/projects/${project.id}/releases`, 'POST', {
      decisionService: 'other/project-age', name: '错误命名空间', description: '',
      target: { type: 'flow', id: ruleset.id },
    });
    assert.equal(invalidNamespace.status, 400);
    assert.match(invalidNamespace.body.error, new RegExp(`${project.id}/grain-alarm`));

    const release = await env.request(`/api/projects/${project.id}/releases`, 'POST', {
      decisionService: `${project.id}/project-age`, name: '项目规则 Release', description: '冻结项目资产和 BOM',
      target: { type: 'flow', id: ruleset.id },
    }, { 'x-actor': 'release-author' });
    assert.equal(release.status, 201);
    assert.equal(release.body.target.id, ruleset.id);
    assert.equal(release.body.createdBy, 'release-author');
    assert.equal(release.body.model.version, 1);
    assert.equal(release.body.model.fields.find(field => field.key === 'customerAge').factType, 'Borrower');
    assert.deepEqual(release.body.qualityGate.suites, []);
    assert.ok(env.engineCalls.filter(call => call.path === '/compile').length >= 2);

    const newerRelease = await env.request(`/api/projects/${project.id}/releases`, 'POST', {
      decisionService: 'project-age', name: '项目规则 Release 2', description: '验证最新版标记',
      target: { type: 'flow', id: ruleset.id },
    });
    assert.equal(newerRelease.status, 201);
    assert.equal(newerRelease.body.version, 2);
    assert.equal(newerRelease.body.latestForDecisionService, true);

    const projectReleases = await env.request(`/api/projects/${project.id}/releases`);
    assert.deepEqual(projectReleases.body.map(item => item.id), [newerRelease.body.id, release.body.id]);
    assert.equal(projectReleases.body[1].createdBy, 'release-author');
    assert.equal(projectReleases.body[0].latestForDecisionService, true);
    assert.equal(projectReleases.body[1].latestForDecisionService, false);
    assert.deepEqual((await env.request(`/api/projects/${otherProject.id}/releases`)).body, []);
    assert.equal((await env.request('/api/releases')).body.some(item => item.id === release.body.id), false);
    assert.equal((await env.request(`/api/projects/${otherProject.id}/releases/${release.body.id}/deploy`, 'POST', { environment: 'local' })).status, 404);
    assert.equal((await env.request(`/api/projects/${otherProject.id}/releases/${release.body.id}/execute`, 'POST', { facts: { customerAge: 17 } })).status, 404);

    const deployed = await env.request(`/api/projects/${project.id}/releases/${release.body.id}/deploy`, 'POST', {
      environment: 'local',
    });
    assert.equal(deployed.status, 200);
    assert.equal(deployed.body.deployments[0].environment, 'local');
    const deployCall = env.resCalls.find(call => call.path === '/deploy');
    assert.equal(deployCall.body.id, release.body.id);
    assert.equal(deployCall.body.checksum, release.body.checksum);
    assert.equal(deployCall.body.model.version, release.body.model.version);

    const invalidFacts = await env.request(`/api/projects/${project.id}/releases/${release.body.id}/execute`, 'POST', {
      facts: { customerAge: '17' },
    });
    assert.equal(invalidFacts.status, 400);
    const executed = await env.request(`/api/projects/${project.id}/releases/${release.body.id}/execute`, 'POST', {
      requestId: 'project-release-1', facts: { customerAge: 17 },
    });
    assert.equal(executed.status, 200);
    assert.equal(executed.body.releaseId, release.body.id);
    const executeCall = env.resCalls.find(call => call.path === '/execute');
    assert.deepEqual(executeCall.body, {
      releaseId: release.body.id, requestId: 'project-release-1', facts: { customerAge: 17 },
    });

    const audit = await env.request(`/api/projects/${project.id}/audit-events?limit=20`);
    assert.ok(audit.body.some(event => event.action === 'release.created' && event.resourceId === release.body.id));
    assert.ok(audit.body.some(event => event.action === 'release.deployed' && event.resourceId === release.body.id));
    assert.ok(audit.body.every(event => event.projectId === project.id));

    assert.equal((await env.request(`/api/projects/${project.id}`, 'DELETE')).status, 204);
    const storedReleases = JSON.parse(await fs.readFile(path.join(env.dir, 'releases.json'), 'utf8'));
    assert.equal(storedReleases.some(item => item.id === release.body.id), false);
  } finally {
    await env.stop();
  }
});

test('project Release rejects execution when a frozen required input is missing', async () => {
  const env = await startTestEnv();
  try {
    const project = (await env.request('/api/projects', 'POST', {
      name: '必填字段执行回归', description: '', icon: 'shield', bomTemplate: 'risk',
    })).body;
    const bom = (await env.request(`/api/projects/${project.id}/bom`)).body;
    const fields = bom.factTypes.flatMap(fact => fact.fields.map(field => ({
      key: field.key,
      label: field.label,
      type: field.runtimeType || field.type,
      semanticType: field.type,
      kind: field.direction,
      factType: fact.name,
      factTypeLabel: fact.label,
      group: field.group || fact.label,
      unit: field.unit,
      min: field.min,
      max: field.max,
      enum: field.enum,
      control: field.control,
      description: field.description || '',
      ...(field.key === 'customerAge' ? { required: true } : {}),
    })));
    const savedBom = await env.request(`/api/projects/${project.id}/bom`, 'PUT', {
      version: bom.version,
      fields,
    });
    assert.equal(savedBom.status, 200);

    await env.request(`/api/projects/${project.id}/packages`, 'POST', {
      name: 'eligibility', label: '准入', parentId: null,
    });
    const rule = (await env.request(`/api/projects/${project.id}/rules`, 'POST', {
      type: 'rule', name: '必填年龄规则', category: 'eligibility',
    })).body;
    const draft = structuredClone(rule.draft);
    draft.conditions[0].value = '18';
    draft.actions[0].value = '中';
    const savedRule = (await env.request(`/api/projects/${project.id}/rules/${rule.id}`, 'PUT', {
      revision: rule.revision, draft,
    })).body;
    assert.equal((await env.request(`/api/projects/${project.id}/rules/${rule.id}/publish`, 'POST', {
      revision: savedRule.revision,
    })).status, 200);
    const ruleset = await publishProjectRuleset(env, project.id, rule.id, '必填年龄规则集');
    const release = await env.request(`/api/projects/${project.id}/releases`, 'POST', {
      decisionService: 'required-input', name: '必填字段 Release', target: { type: 'flow', id: ruleset.id },
    });
    assert.equal(release.status, 201);
    assert.equal(release.body.model.fields.find(field => field.key === 'customerAge').required, true);
    assert.equal((await env.request(`/api/projects/${project.id}/releases/${release.body.id}/deploy`, 'POST', {
      environment: 'local',
    })).status, 200);

    const resCallsBefore = env.resCalls.length;
    const missing = await env.request(`/api/projects/${project.id}/releases/${release.body.id}/execute`, 'POST', {
      facts: { annualIncome: 100000 },
    });
    assert.equal(missing.status, 400);
    assert.match(missing.body.error, /输入字段或类型无效/);
    assert.equal(env.resCalls.length, resCallsBefore);
  } finally {
    await env.stop();
  }
});

test('project test suites support isolated CRUD, execution, and Release gates', async () => {
  const env = await startTestEnv();
  try {
    const project = (await env.request('/api/projects', 'POST', {
      name: '项目测试套件回归', description: '验证测试资产项目隔离', icon: 'shield', bomTemplate: 'risk',
    })).body;
    const otherProject = (await env.request('/api/projects', 'POST', {
      name: '测试套件隔离项目', description: '', icon: 'shield', bomTemplate: 'risk',
    })).body;
    await env.request(`/api/projects/${project.id}/packages`, 'POST', {
      name: 'eligibility', label: '准入', parentId: null,
    });
    const createdRule = (await env.request(`/api/projects/${project.id}/rules`, 'POST', {
      type: 'rule', name: '测试套件年龄准入', category: 'eligibility',
    })).body;
    const draft = structuredClone(createdRule.draft);
    draft.conditions[0].value = '18';
    draft.actions[0].value = '中';
    const savedRule = (await env.request(`/api/projects/${project.id}/rules/${createdRule.id}`, 'PUT', {
      revision: createdRule.revision, draft,
    })).body;
    assert.equal((await env.request(`/api/projects/${project.id}/rules/${createdRule.id}/publish`, 'POST', {
      revision: savedRule.revision,
    })).status, 200);
    const ruleset = await publishProjectRuleset(env, project.id, createdRule.id, '项目年龄准入规则集');

    const suitePayload = {
      name: '项目年龄准入回归', description: '项目级必需套件',
      target: { type: 'flow', id: ruleset.id }, required: true,
      cases: [{
        id: 'underage', name: '未成年客户', enabled: true, facts: { customerAge: 17 },
        expected: { outputs: { riskLevel: '高' }, fired: ['mock 规则 [1]'] },
      }],
    };
    const createdSuite = await env.request(`/api/projects/${project.id}/tests`, 'POST', suitePayload);
    assert.equal(createdSuite.status, 201);
    assert.equal(createdSuite.body.revision, 1);
    assert.equal(createdSuite.body.targetName, '项目年龄准入规则集');
    const suiteId = createdSuite.body.id;

    assert.deepEqual((await env.request(`/api/projects/${project.id}/test-suites`)).body.map(item => item.id), [suiteId]);
    assert.deepEqual((await env.request(`/api/projects/${project.id}/tests`)).body.map(item => item.id), [suiteId]);
    assert.deepEqual((await env.request(`/api/projects/${otherProject.id}/tests`)).body, []);
    assert.equal((await env.request('/api/test-suites')).body.some(item => item.id === suiteId), false);
    assert.equal((await env.request(`/api/projects/${otherProject.id}/tests/${suiteId}/run`, 'POST')).status, 404);

    const failedRun = await env.request(`/api/projects/${project.id}/tests/${suiteId}/run`, 'POST');
    assert.equal(failedRun.status, 200);
    assert.equal(failedRun.body.report.passed, false);
    assert.equal(failedRun.body.suite.revision, 2);
    const versionRun = await env.request(`/api/projects/${project.id}/test-suites/${suiteId}/run`, 'POST', { targetVersion: 1 });
    assert.equal(versionRun.status, 200);
    assert.equal(versionRun.body.report.targetVersion, 1);
    const blockedRelease = await env.request(`/api/projects/${project.id}/releases`, 'POST', {
      decisionService: `${project.id}/gated`, name: '应被测试门禁阻止', description: '',
      target: { type: 'flow', id: ruleset.id },
    });
    assert.equal(blockedRelease.status, 409);
    assert.equal(blockedRelease.body.gate.suites[0].id, suiteId);
    assert.equal(blockedRelease.body.gate.suites[0].passed, false);
    assert.equal(blockedRelease.body.failedCases[0].suiteId, suiteId);
    assert.equal(blockedRelease.body.failedCases[0].caseId, 'underage');

    const currentSuite = (await env.request(`/api/projects/${project.id}/tests`)).body[0];
    const passingPayload = structuredClone(suitePayload);
    passingPayload.name = '项目年龄准入每日回归';
    passingPayload.cases[0].expected.outputs.riskLevel = '中';
    const updatedSuite = await env.request(`/api/projects/${project.id}/tests/${suiteId}`, 'PUT', {
      ...passingPayload, revision: currentSuite.revision,
    });
    assert.equal(updatedSuite.status, 200);
    assert.equal(updatedSuite.body.name, '项目年龄准入每日回归');
    const staleUpdate = await env.request(`/api/projects/${project.id}/tests/${suiteId}`, 'PUT', {
      ...passingPayload, name: '过期更新', revision: currentSuite.revision,
    });
    assert.equal(staleUpdate.status, 409);
    assert.equal(staleUpdate.body.currentRevision, updatedSuite.body.revision);

    const passingRun = await env.request(`/api/projects/${project.id}/tests/${suiteId}/run`, 'POST');
    assert.equal(passingRun.body.report.passed, true);
    const allRuns = await env.request(`/api/projects/${project.id}/tests/run`, 'POST');
    assert.equal(allRuns.status, 200);
    assert.equal(allRuns.body.total, 1);
    assert.equal(allRuns.body.passedCount, 1);

    const release = await env.request(`/api/projects/${project.id}/releases`, 'POST', {
      decisionService: 'gated', name: '测试门禁通过', description: '',
      target: { type: 'flow', id: ruleset.id },
    });
    assert.equal(release.status, 201);
    assert.equal(release.body.decisionService, `${project.id}/gated`);
    assert.equal(release.body.latestForDecisionService, true);
    assert.equal(release.body.qualityGate.suites.length, 1);
    assert.equal(release.body.qualityGate.suites[0].id, suiteId);
    assert.equal(release.body.qualityGate.suites[0].passed, true);

    const latestSuite = (await env.request(`/api/projects/${project.id}/tests`)).body[0];
    const archived = await env.request(`/api/projects/${project.id}/tests/${suiteId}/archive`, 'POST', {
      revision: latestSuite.revision,
    });
    assert.equal(archived.status, 200);
    assert.deepEqual((await env.request(`/api/projects/${project.id}/tests`)).body, []);

    assert.equal((await env.request(`/api/projects/${project.id}`, 'DELETE')).status, 204);
    const storedSuites = JSON.parse(await fs.readFile(path.join(env.dir, 'test-suites.json'), 'utf8'));
    assert.equal(storedSuites.some(item => item.id === suiteId), false);
  } finally {
    await env.stop();
  }
});

test('CEP project supports event-stream publish, suite gate, release and local execute', async () => {
  const env = await startTestEnv({ cepApiKey: 'cep-test-key' });
  try {
    const project = await env.request('/api/projects', 'POST', {
      name: 'CEP 传感器监控', description: '事件流回归', icon: 'warehouse', engine: 'cep', bomTemplate: 'grain',
    });
    assert.equal(project.status, 201);
    const projectId = project.body.id;

    const created = await env.request(`/api/projects/${projectId}/event-streams`, 'POST', {
      name: '高温事件流',
      statements: [{ name: 'HighTemperature', epl: 'insert into HighTemperatureEvent select * from GrainStore where averageTemperature > 25' }],
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.type, 'event-stream');

    const compiled = await env.request(`/api/projects/${projectId}/event-streams/${created.body.id}/compile`, 'POST', {
      revision: created.body.revision,
      draft: created.body.draft,
    });
    assert.equal(compiled.status, 200);
    assert.equal(compiled.body.ok, true);
    assert.equal(env.cepCalls.at(-1).headers['x-api-key'], 'cep-test-key');
    const grainSchema = compiled.body.schemas.find(schema => schema.name === 'GrainStore');
    assert.ok(grainSchema.fields.some(field => field.key === 'eventKey' && field.envelope === true));
    assert.ok(grainSchema.fields.some(field => field.key === 'warehouseId' && field.required === true));

    const published = await env.request(`/api/projects/${projectId}/event-streams/${created.body.id}/publish`, 'POST', { revision: created.body.revision });
    assert.equal(published.status, 200);
    assert.equal(published.body.status, 'published');
    assert.equal(published.body.hasDraftChanges, false);

    const savedAfterPublish = await env.request(`/api/projects/${projectId}/event-streams/${created.body.id}`, 'PUT', {
      revision: published.body.revision,
      draft: { ...published.body.draft, description: '下一版本草稿' },
    });
    assert.equal(savedAfterPublish.status, 200);
    assert.equal(savedAfterPublish.body.hasDraftChanges, true);
    const streamList = await env.request(`/api/projects/${projectId}/event-streams`);
    assert.equal(streamList.body.find(item => item.id === created.body.id).hasDraftChanges, true);

    const suite = await env.request(`/api/projects/${projectId}/test-suites`, 'POST', {
      name: '高温事件检测', description: '', target: { type: 'event-stream', id: created.body.id }, required: true,
      cases: [{
        id: 'case-1', name: '均温超限', enabled: true,
        events: [{
          id: 'evt-1', type: 'GrainStore', eventTime: '2026-09-30T14:00:00Z', source: 'sensor-gw-1', key: 'warehouse-1', schemaVersion: 1, traceId: 'trace-1',
          data: { eventId: 'evt-1', warehouseId: 'warehouse-1', sensorId: 'sensor-1', sampledAt: '2026-09-30', averageTemperature: 32, humidity: 70 },
        }],
        expectedEvents: [{ statement: 'HighTemperature', eventType: 'HighTemperatureEvent', count: 1 }],
      }],
    });
    assert.equal(suite.status, 201);

    const run = await env.request(`/api/projects/${projectId}/test-suites/${suite.body.id}/run`, 'POST');
    assert.equal(run.status, 200);
    assert.equal(run.body.report.passed, true);

    const release = await env.request(`/api/projects/${projectId}/releases`, 'POST', {
      decisionService: 'grain-cep', name: 'CEP v1', target: { type: 'event-stream', id: created.body.id },
    });
    assert.equal(release.status, 201);
    assert.equal(release.body.schemaVersion, 2);
    assert.equal(release.body.engine.type, 'esper');

    const deployed = await env.request(`/api/projects/${projectId}/releases/${release.body.id}/deploy`, 'POST', { environment: 'local' });
    assert.equal(deployed.status, 200);
    assert.ok(deployed.body.deployments.some(item => item.environment === 'local'));

    const executed = await env.request(`/api/projects/${projectId}/releases/${release.body.id}/execute`, 'POST', {
      events: [{
        id: 'evt-1', type: 'GrainStore', eventTime: '2026-09-30T14:00:00Z', source: 'sensor-gw-1', key: 'warehouse-1', schemaVersion: 1, traceId: 'trace-1',
        data: { eventId: 'evt-1', warehouseId: 'warehouse-1', sensorId: 'sensor-1', sampledAt: '2026-09-30', averageTemperature: 32, humidity: 70 },
      }],
    });
    assert.equal(executed.status, 200);
    assert.equal(executed.body.detections.length, 1);

    const webhook = await env.request(`/api/projects/${projectId}/releases/${release.body.id}/webhook`, 'POST', {
      enabled: true, callbackUrl: 'http://callback.local/alerts', secret: 'secret', clearedAfterMs: 1000, maxRetries: 1, minIntervalMs: 500,
    });
    assert.equal(webhook.status, 200);
    assert.equal(env.cepCalls.at(-1).path, '/webhook');
    assert.equal(env.cepCalls.at(-1).headers['x-api-key'], 'cep-test-key');
    assert.equal(env.cepCalls.at(-1).body.webhook.minIntervalMs, 500);

    const posted = await env.request(`/api/projects/${projectId}/releases/${release.body.id}/events`, 'POST', {
      events: [{
        id: 'evt-2', type: 'GrainStore', eventTime: '2026-09-30T14:01:00Z', source: 'sensor-gw-1', key: 'warehouse-1', schemaVersion: 1, traceId: 'trace-2',
        data: { eventId: 'evt-2', warehouseId: 'warehouse-1', sensorId: 'sensor-1', sampledAt: '2026-09-30', averageTemperature: 33, humidity: 70 },
      }],
    });
    assert.equal(posted.status, 202);
    assert.equal(posted.body.accepted, 1);
    assert.equal(env.cepCalls.at(-1).path, `/events/${release.body.id}`);
    assert.equal(env.cepCalls.at(-1).headers['x-api-key'], 'cep-test-key');

    const disabledWebhook = await env.request(`/api/projects/${projectId}/releases/${release.body.id}/webhook`, 'POST', { enabled: false });
    assert.equal(disabledWebhook.status, 200);
    assert.equal(env.cepCalls.at(-1).path, '/webhook');
    assert.equal(env.cepCalls.at(-1).body.webhook.enabled, false);
  } finally {
    await env.stop();
  }
});

test('CEP draft event-stream can prepare a test skeleton before publish', async () => {
  const env = await startTestEnv({ cepApiKey: 'cep-test-key' });
  try {
    const project = await env.request('/api/projects', 'POST', {
      name: 'CEP 草稿测试', description: '先准备测试再发布', icon: 'warehouse', engine: 'cep', bomTemplate: 'grain',
    });
    assert.equal(project.status, 201);
    const projectId = project.body.id;

    const created = await env.request(`/api/projects/${projectId}/event-streams`, 'POST', {
      name: '高温草稿事件流',
      statements: [{ name: 'HighTemperature', epl: 'insert into HighTemperatureEvent select * from GrainStore where averageTemperature > 25' }],
    });
    assert.equal(created.status, 201);

    const suite = await env.request(`/api/projects/${projectId}/test-suites`, 'POST', {
      name: '高温草稿测试骨架', description: '', target: { type: 'event-stream', id: created.body.id }, required: false,
      cases: [{
        id: 'case-1', name: '均温超限', enabled: true,
        events: [{
          id: 'evt-1', type: 'GrainStore', eventTime: '2026-10-01T00:00:00Z', source: 'sensor-1', key: 'warehouse-1', schemaVersion: 1,
          data: { eventId: 'evt-1', warehouseId: 'warehouse-1', sensorId: 'sensor-1', sampledAt: '2026-10-01', averageTemperature: 32, humidity: 60 },
        }],
        expectedEvents: [{ statement: 'HighTemperature', eventType: 'HighTemperatureEvent', count: 1 }],
      }],
    });
    assert.equal(suite.status, 201);
    assert.deepEqual(suite.body.targetVersions, []);

    const beforePublish = await env.request(`/api/projects/${projectId}/test-suites/${suite.body.id}/run`, 'POST');
    assert.equal(beforePublish.status, 200);
    assert.equal(beforePublish.body.report.passed, false);
    assert.match(beforePublish.body.report.error, /尚未发布/);

    const published = await env.request(`/api/projects/${projectId}/event-streams/${created.body.id}/publish`, 'POST', {
      revision: created.body.revision,
    });
    assert.equal(published.status, 200);
    const afterPublish = await env.request(`/api/projects/${projectId}/test-suites/${suite.body.id}/run`, 'POST');
    assert.equal(afterPublish.status, 200);
    assert.equal(afterPublish.body.report.passed, true);
  } finally {
    await env.stop();
  }
});

test('CEP event-stream exposes dependencies and blocks removing the only producer', async () => {
  const env = await startTestEnv();
  try {
    const project = await env.request('/api/projects', 'POST', {
      name: 'CEP 依赖分析', description: '派生事件引用', icon: 'warehouse', engine: 'cep', bomTemplate: 'grain',
    });
    const projectId = project.body.id;
    const created = await env.request(`/api/projects/${projectId}/event-streams`, 'POST', {
      name: '多阶段事件流',
      statements: [
        { name: 'ProduceAlarm', epl: 'insert into AlarmEvent select * from GrainStore where averageTemperature > 25' },
        { name: 'ConsumeAlarm', epl: 'insert into EscalatedEvent select * from AlarmEvent' },
      ],
    });
    assert.equal(created.status, 201);
    assert.deepEqual(created.body.dependencyGraph.dependencies, [{
      eventType: 'AlarmEvent', consumer: 'ConsumeAlarm', producers: ['ProduceAlarm'], selfReference: false,
    }]);

    const blocked = await env.request(`/api/projects/${projectId}/event-streams/${created.body.id}`, 'PUT', {
      revision: created.body.revision,
      draft: { ...created.body.draft, statements: created.body.draft.statements.filter(statement => statement.name !== 'ProduceAlarm') },
    });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.code, 'EVENT_STREAM_DEPENDENCY_CONFLICT');
    assert.equal(blocked.body.details.dependencies[0].eventType, 'AlarmEvent');
  } finally {
    await env.stop();
  }
});

test('CEP event-stream deletion is revision-safe and preserves immutable releases', async () => {
  const env = await startTestEnv({ cepApiKey: 'cep-test-key' });
  try {
    const project = await env.request('/api/projects', 'POST', {
      name: 'CEP 删除回归', description: '事件流软删除', icon: 'warehouse', engine: 'cep', bomTemplate: 'grain',
    });
    assert.equal(project.status, 201);
    const projectId = project.body.id;

    const created = await env.request(`/api/projects/${projectId}/event-streams`, 'POST', {
      name: '待归档事件流',
      statements: [{ name: 'HighTemperature', epl: 'insert into HighTemperatureEvent select * from GrainStore where averageTemperature > 25' }],
    });
    assert.equal(created.status, 201);

    const published = await env.request(`/api/projects/${projectId}/event-streams/${created.body.id}/publish`, 'POST', {
      revision: created.body.revision,
    });
    assert.equal(published.status, 200);

    const release = await env.request(`/api/projects/${projectId}/releases`, 'POST', {
      decisionService: 'archived-stream', name: '删除前发布包', target: { type: 'event-stream', id: created.body.id },
    });
    assert.equal(release.status, 201);

    const stale = await env.request(`/api/projects/${projectId}/event-streams/${created.body.id}`, 'DELETE', {
      revision: published.body.revision - 1,
    });
    assert.equal(stale.status, 409);

    const deleted = await env.request(`/api/projects/${projectId}/event-streams/${created.body.id}`, 'DELETE', {
      revision: published.body.revision,
    });
    assert.equal(deleted.status, 204);
    assert.deepEqual((await env.request(`/api/projects/${projectId}/event-streams`)).body, []);
    const archivedStreams = await env.request(`/api/projects/${projectId}/event-streams?archived=true`);
    assert.equal(archivedStreams.body[0].id, created.body.id);
    const archivedDetail = await env.request(`/api/projects/${projectId}/event-streams/${created.body.id}`);
    assert.equal(archivedDetail.status, 200);
    assert.equal(archivedDetail.body.status, 'archived');

    const releases = await env.request(`/api/projects/${projectId}/releases`);
    assert.equal(releases.status, 200);
    assert.ok(releases.body.some(item => item.id === release.body.id));
    const recreate = await env.request(`/api/projects/${projectId}/releases`, 'POST', {
      decisionService: 'archived-stream-2', name: '删除后发布包', target: { type: 'event-stream', id: created.body.id },
    });
    assert.equal(recreate.status, 400);

    const restored = await env.request(`/api/projects/${projectId}/event-streams/${created.body.id}/restore`, 'POST', {
      revision: archivedDetail.body.revision,
    });
    assert.equal(restored.status, 200);
    assert.equal(restored.body.status, 'draft');
    assert.equal(restored.body.version, published.body.version);
    assert.equal(restored.body.published, null);
    assert.equal((await env.request(`/api/projects/${projectId}/event-streams`)).body[0].id, created.body.id);
    const audit = await env.request(`/api/projects/${projectId}/audit-events`);
    assert.ok(audit.body.some(event => event.action === 'asset.restored' && event.resourceId === created.body.id));
  } finally {
    await env.stop();
  }
});
