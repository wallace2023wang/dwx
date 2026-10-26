#!/usr/bin/env node

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { tableDrl, validateTable } from '../../shared/assets.js';
import { defaultBom } from '../../shared/bom.js';
import { releaseChecksum } from '../../shared/releases.js';
import { generateDrl } from '../../shared/rules.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const cli = process.argv.slice(2);
const has = name => cli.includes(name);
const valueOf = name => cli.find(value => value.startsWith(name + '='))?.slice(name.length + 1);
const sizes = (valueOf('--sizes') || '1000,5000,10000').split(',').map(Number).filter(value => Number.isInteger(value) && value > 0);
const quick = has('--quick');
const skipBrowser = has('--skip-browser');
const skipRuntime = has('--skip-runtime');
const keepTemporary = has('--keep-temporary');
const outputDir = path.resolve(ROOT, valueOf('--output') || 'benchmarks/capacity/results');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');

if (!sizes.length) throw new Error('至少提供一个有效档位，例如 --sizes=1000,5000,10000');

function percentile(values, fraction) {
  if (!values.length) return null;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * fraction) - 1)];
}

function summary(values) {
  return {
    samples: values.length,
    minMs: values.length ? Math.min(...values) : null,
    p50Ms: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
    p99Ms: percentile(values, 0.99),
    maxMs: values.length ? Math.max(...values) : null,
  };
}

const fixed = value => value == null ? '-' : Number(value).toFixed(1);

function bytes(value) {
  if (value == null) return '-';
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  let amount = value;
  let index = 0;
  while (amount >= 1024 && index < units.length - 1) { amount /= 1024; index += 1; }
  return amount.toFixed(index ? 2 : 0) + ' ' + units[index];
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

function command(program, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      cwd: ROOT, stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      env: { ...process.env, ...options.env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', chunk => { stdout += chunk; });
    child.stderr?.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', code => code === 0
      ? resolve({ stdout, stderr })
      : reject(new Error(program + ' ' + args.join(' ') + ' 退出码 ' + code + (stderr ? '：' + stderr.trim() : ''))));
  });
}

async function waitFor(url, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  let message = 'unknown';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (response.ok) return;
      message = 'HTTP ' + response.status;
    } catch (error) { message = error.message; }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error('等待 ' + url + ' 超时：' + message);
}

function capacityRule(index) {
  return {
    name: '容量规则 ' + String(index + 1).padStart(5, '0'),
    description: '', category: 'capacity', priority: index % 1000,
    conditions: [{ field: 'creditScore', operator: '>=', value: String(300 + (index % 601)) }],
    actions: [{ field: 'riskLevel', value: ['低', '中', '高'][index % 3] }],
  };
}

function capacityTable(size) {
  return {
    name: '容量决策表 ' + size, description: '', category: 'capacity', priority: 0, hitPolicy: 'FIRST',
    conditions: [{ field: 'creditScore', operator: '>=' }],
    actions: [{ field: 'riskLevel' }],
    rows: Array.from({ length: size }, (_, index) => ({
      enabled: true, priority: index % 1000,
      conditions: [String(300 + (index % 601))], actions: [['低', '中', '高'][index % 3]],
    })),
    defaultRow: null,
  };
}

function assetRecord(index, now) {
  const draft = capacityRule(index);
  return {
    id: 'capacity-rule-' + String(index + 1).padStart(5, '0'),
    draft, published: structuredClone(draft),
    versions: [{ number: 1, createdAt: now, bomVersion: 1, rule: structuredClone(draft) }],
    revision: 1, revisions: [{ number: 1, createdAt: now, draft: structuredClone(draft) }],
    lifecycleStatus: 'active', archived: false, updatedAt: now,
    ownerId: 'capacity-runner', ownerName: 'Capacity Runner', projectId: 'capacity',
  };
}

async function writeDataset(directory, size) {
  const now = new Date().toISOString();
  const names = {
    rules: 'rules.json', tables: 'tables.json', flows: 'flows.json', eventStreams: 'event-streams.json',
    releases: 'releases.json', applicationPackages: 'application-packages.json', targets: 'targets.json',
    activationGenerations: 'activation-generations.json', deployments: 'deployments.json',
    environments: 'environments.json', testSuites: 'test-suites.json', bom: 'bom.json',
    adminUsers: 'admin-users.json', changeSets: 'change-sets.json', audit: 'audit-events.json',
    projects: 'projects.json', packages: 'packages.json',
  };
  const project = {
    id: 'capacity', name: '容量基准 ' + size, description: '隔离生成的容量基准项目',
    icon: 'shield', version: 'v1.0.0', branch: 'main', defaultEnvironment: 'local',
    archived: false, createdAt: now, updatedAt: now, updatedBy: 'Capacity Runner',
    engine: 'rules', variables: [],
    approvalPolicy: { requiredApprovals: 1, requireComment: false, preventSelfApproval: true, allowedReviewerRoles: ['reviewer', 'admin'] },
  };
  const empty = [];
  const values = {
    rules: Array.from({ length: size }, (_, index) => assetRecord(index, now)),
    tables: empty, flows: empty, eventStreams: empty, releases: empty, applicationPackages: empty,
    targets: empty, activationGenerations: empty, deployments: empty,
    environments: [{ id: 'local', name: '本地', order: 0 }], testSuites: empty,
    bom: defaultBom(), adminUsers: empty, changeSets: empty, audit: empty,
    projects: [project],
    packages: [{ name: 'capacity', label: '容量基准', parentId: null, createdAt: now, projectId: 'capacity' }],
  };
  await fs.mkdir(directory, { recursive: true });
  await Promise.all(Object.entries(names).map(([key, filename]) => fs.writeFile(path.join(directory, filename), JSON.stringify(values[key]))));
  return Object.fromEntries(Object.entries(names).map(([key, filename]) => [key, path.join(directory, filename)]));
}

function apiEnvironment(files, port) {
  return {
    API_PORT: String(port), AUTH_MODE: 'local',
    RULES_DATA_FILE: files.rules, RULES_TABLES_FILE: files.tables, RULES_FLOWS_FILE: files.flows,
    RULES_EVENT_STREAMS_FILE: files.eventStreams, RULES_RELEASES_FILE: files.releases,
    RULES_APPLICATION_PACKAGES_FILE: files.applicationPackages, RULES_TARGETS_FILE: files.targets,
    RULES_ACTIVATION_GENERATIONS_FILE: files.activationGenerations, RULES_DEPLOYMENTS_FILE: files.deployments,
    RULES_ENVIRONMENTS_FILE: files.environments, RULES_TEST_SUITES_FILE: files.testSuites,
    RULES_BOM_FILE: files.bom, RULES_ADMIN_USERS_FILE: files.adminUsers,
    RULES_CHANGE_SETS_FILE: files.changeSets, RULES_AUDIT_FILE: files.audit,
    RULES_PROJECTS_FILE: files.projects, RULES_PACKAGES_FILE: files.packages,
  };
}

async function stop(child) {
  if (!child || child.exitCode != null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise(resolve => child.once('exit', resolve)),
    new Promise(resolve => setTimeout(resolve, 3000)),
  ]);
  if (child.exitCode == null) child.kill('SIGKILL');
}

async function measureHttp(url, count) {
  const durations = [];
  let responseBytes = 0;
  for (let index = 0; index < count; index += 1) {
    const started = performance.now();
    const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
    const body = await response.arrayBuffer();
    durations.push(performance.now() - started);
    responseBytes = body.byteLength;
    if (!response.ok) throw new Error(url + ' 返回 HTTP ' + response.status);
  }
  return { ...summary(durations), responseBytes };
}

async function measureBrowser(frontendUrl, size) {
  if (skipBrowser) return { status: 'skipped', reason: '--skip-browser' };
  let chromium;
  try { ({ chromium } = await import('../../e2e/node_modules/playwright/index.mjs')); }
  catch (error) { return { status: 'skipped', reason: 'Playwright 不可用：' + error.message }; }
  let browser;
  try {
    try {
      browser = await chromium.launch({ headless: true });
    } catch (error) {
      const candidates = [
        process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
        '/usr/bin/google-chrome',
        '/usr/bin/chromium',
      ].filter(Boolean);
      let executablePath = null;
      for (const candidate of candidates) {
        try { await fs.access(candidate); executablePath = candidate; break; } catch {}
      }
      if (!executablePath) throw error;
      browser = await chromium.launch({ headless: true, executablePath });
    }
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(frontendUrl + '/login', { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.getByRole('button', { name: '登 录' }).click();
    await page.waitForURL('**/library', { timeout: 120000 });
    const started = performance.now();
    await page.goto(frontendUrl + '/projects/capacity/assets', { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.getByRole('region', { name: '资产列表' }).waitFor({ state: 'visible', timeout: 120000 });
    await page.waitForFunction(expected => document.querySelectorAll('[aria-label=\"资产列表\"] tbody tr').length === expected, size, { timeout: 180000 });
    const interactiveMs = performance.now() - started;
    const renderedRows = await page.locator('[aria-label=\"资产列表\"] tbody tr').count();
    const searchStarted = performance.now();
    await page.getByPlaceholder('搜索名称或标签').fill('容量规则 ' + String(size).padStart(5, '0'));
    await page.waitForFunction(() => document.querySelectorAll('[aria-label=\"资产列表\"] tbody tr').length === 1, null, { timeout: 120000 });
    return { status: 'ok', interactiveMs, searchMs: performance.now() - searchStarted, renderedRows };
  } catch (error) {
    return { status: 'failed', error: error.message };
  } finally {
    await browser?.close();
  }
}

async function benchmarkControlPlane(size, temporaryRoot, frontendUrl, apiPort) {
  const files = await writeDataset(path.join(temporaryRoot, 'data-' + size), size);
  const api = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...apiEnvironment(files, apiPort) },
  });
  let logs = '';
  api.stdout.on('data', chunk => { logs += chunk; });
  api.stderr.on('data', chunk => { logs += chunk; });
  try {
    await waitFor('http://127.0.0.1:' + apiPort + '/api/session');
    const count = quick ? 3 : 12;
    const projectApi = await measureHttp('http://127.0.0.1:' + apiPort + '/api/projects/capacity', count);
    const packagesApi = await measureHttp('http://127.0.0.1:' + apiPort + '/api/projects/capacity/packages', count);
    const browser = await measureBrowser(frontendUrl, size);
    return { projectApi, packagesApi, browser };
  } catch (error) {
    throw new Error(error.message + (logs ? '\nTeam Server:\n' + logs.slice(-4000) : ''));
  } finally {
    await stop(api);
  }
}

function parseMemory(value) {
  const match = String(value).match(/^([0-9.]+)([KMG]iB)$/);
  if (!match) return 0;
  return Number(match[1]) * { KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3 }[match[2]];
}

async function mappedPort(container, internalPort) {
  const result = await command('docker', ['port', container, internalPort + '/tcp'], { capture: true });
  return Number(result.stdout.trim().split(':').at(-1));
}

async function memorySampler(container) {
  let peakBytes = 0;
  let stopped = false;
  const sample = async () => {
    if (stopped) return;
    try {
      const result = await command('docker', ['stats', '--no-stream', '--format', '{{.MemUsage}}', container], { capture: true });
      peakBytes = Math.max(peakBytes, parseMemory(result.stdout.trim().split('/')[0].trim()));
    } catch {}
  };
  const timer = setInterval(sample, 500);
  await sample();
  return {
    value: () => peakBytes,
    close: async () => { clearInterval(timer); await sample(); stopped = true; },
  };
}

async function postJson(url, payload, timeoutMs = 900000) {
  const started = performance.now();
  const response = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload), signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: response.status, ok: response.ok, body, durationMs: performance.now() - started };
}

async function removeContainer(container) {
  if (container) await command('docker', ['rm', '-f', container], { capture: true }).catch(() => undefined);
}

async function benchmarkRuntime(size, tableText, groupText) {
  if (skipRuntime) return { status: 'skipped', reason: '--skip-runtime' };
  let engine;
  let res;
  try {
    const engineStarted = performance.now();
    engine = (await command('docker', ['run', '-d', '-p', '127.0.0.1::8788', 'rules-capacity-engine:latest'], { capture: true })).stdout.trim();
    const enginePort = await mappedPort(engine, 8788);
    await waitFor('http://127.0.0.1:' + enginePort + '/health', 180000);
    const engineStartupMs = performance.now() - engineStarted;
    const engineMemory = await memorySampler(engine);
    const tableCompile = await postJson('http://127.0.0.1:' + enginePort + '/compile', { drl: tableText });
    const ruleGroupCompile = await postJson('http://127.0.0.1:' + enginePort + '/compile', { drl: groupText });
    await engineMemory.close();

    const resStarted = performance.now();
    res = (await command('docker', ['run', '-d', '-p', '127.0.0.1::8790', '-p', '127.0.0.1::8793', '-e', 'RES_DATA_DIR=/tmp/releases', 'rules-capacity-res:latest'], { capture: true })).stdout.trim();
    const executionPort = await mappedPort(res, 8790);
    const managementPort = await mappedPort(res, 8793);
    await Promise.all([
      waitFor('http://127.0.0.1:' + executionPort + '/health', 180000),
      waitFor('http://127.0.0.1:' + managementPort + '/health', 180000),
    ]);
    const resStartupMs = performance.now() - resStarted;
    const resMemory = await memorySampler(res);
    const release = {
      schemaVersion: 1, id: 'capacity-table-' + size,
      decisionService: 'capacity/table-' + size, version: 1,
      name: '容量表 ' + size, description: '',
      target: { type: 'table', id: 'capacity-table-' + size, assetVersion: 1 },
      engine: { type: 'drools', drools: '10.2.0' }, model: defaultBom(),
      steps: [{ name: '容量决策表 ' + size, type: 'table', assetVersion: 1, drl: tableText }],
    };
    release.checksum = releaseChecksum(release);
    const artifactBytes = Buffer.byteLength(JSON.stringify(release));
    const deploy = await postJson('http://127.0.0.1:' + managementPort + '/prepare', release);
    const activate = deploy.ok
      ? await postJson('http://127.0.0.1:' + managementPort + '/activate', { releaseId: release.id, decisionService: release.decisionService })
      : null;
    const warmups = quick ? 2 : 10;
    const count = quick ? 5 : 40;
    const durations = [];
    let executeError = null;
    if (deploy.ok && activate?.ok) {
      for (let index = 0; index < warmups + count; index += 1) {
        const executed = await postJson('http://127.0.0.1:' + executionPort + '/execute', { releaseId: release.id, facts: { creditScore: 900 } });
        if (!executed.ok) { executeError = { status: executed.status, body: executed.body }; break; }
        if (index >= warmups) durations.push(executed.durationMs);
      }
    }
    await resMemory.close();
    const ok = tableCompile.ok && ruleGroupCompile.ok && deploy.ok && activate?.ok && !executeError;
    return {
      status: ok ? 'ok' : 'failed', engineStartupMs, resStartupMs,
      enginePeakMemoryBytes: engineMemory.value(), resPeakMemoryBytes: resMemory.value(),
      tableCompile: { status: tableCompile.status, durationMs: tableCompile.durationMs, error: tableCompile.ok ? null : tableCompile.body },
      ruleGroupCompile: { status: ruleGroupCompile.status, durationMs: ruleGroupCompile.durationMs, error: ruleGroupCompile.ok ? null : ruleGroupCompile.body },
      deploy: { status: deploy.status, durationMs: deploy.durationMs, error: deploy.ok ? null : deploy.body },
      activateStatus: activate?.status || null, artifactBytes,
      hotExecution: { ...summary(durations), error: executeError },
    };
  } catch (error) {
    return { status: 'failed', error: error.message };
  } finally {
    await removeContainer(engine);
    await removeContainer(res);
  }
}

async function buildRuntimeImages() {
  if (skipRuntime) return;
  await command('docker', ['build', '-q', '-t', 'rules-capacity-engine:latest', 'engine'], { capture: true });
  await command('docker', ['build', '-q', '-t', 'rules-capacity-res:latest', 'res'], { capture: true });
}

async function startFrontend(apiPort) {
  if (skipBrowser) return { url: null, child: null };
  const port = await freePort();
  const child = spawn('npm', ['--prefix', 'frontend', 'run', 'dev', '--', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, VITE_API_PROXY: 'http://127.0.0.1:' + apiPort },
  });
  let logs = '';
  child.stdout.on('data', chunk => { logs += chunk; });
  child.stderr.on('data', chunk => { logs += chunk; });
  try { await waitFor('http://127.0.0.1:' + port + '/login'); }
  catch (error) { await stop(child); throw new Error(error.message + '\nVite:\n' + logs.slice(-4000)); }
  return { url: 'http://127.0.0.1:' + port, child };
}

function markdown(report) {
  const lines = [
    '# 1k/5k/10k 容量基准报告', '',
    '生成时间：' + report.generatedAt, '',
    '环境：' + report.environment.platform + ' ' + report.environment.arch + '，Node ' + report.environment.node
      + '，CPU ' + report.environment.cpus + ' 核，内存 ' + bytes(report.environment.memoryBytes), '',
    '## 结论', '', report.conclusion, '', '## 分档结果', '',
    '| 档位 | 资产 API P95 | 包列表 API P95 | 前端可交互 | 搜索交互 | 表 DRL | Group DRL | 表编译 | Group 编译 | RES 部署 | 热执行 P95/P99 | RES 峰值内存 |',
    '|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
  ];
  for (const tier of report.tiers) {
    const runtime = tier.runtime || {};
    const controlPlane = tier.controlPlane || {};
    const browser = controlPlane.browser || {};
    const projectApi = controlPlane.projectApi || {};
    const packagesApi = controlPlane.packagesApi || {};
    const generation = tier.generation || {};
    lines.push('| ' + tier.size.toLocaleString()
      + ' | ' + fixed(projectApi.p95Ms) + 'ms'
      + ' | ' + fixed(packagesApi.p95Ms) + 'ms'
      + ' | ' + fixed(browser.interactiveMs) + 'ms'
      + ' | ' + fixed(browser.searchMs) + 'ms'
      + ' | ' + bytes(generation.tableDrlBytes)
      + ' | ' + bytes(generation.ruleGroupDrlBytes)
      + ' | ' + fixed(runtime.tableCompile?.durationMs) + 'ms (' + (runtime.tableCompile?.status ?? '-') + ')'
      + ' | ' + fixed(runtime.ruleGroupCompile?.durationMs) + 'ms (' + (runtime.ruleGroupCompile?.status ?? '-') + ')'
      + ' | ' + fixed(runtime.deploy?.durationMs) + 'ms (' + (runtime.deploy?.status ?? '-') + ')'
      + ' | ' + fixed(runtime.hotExecution?.p95Ms) + '/' + fixed(runtime.hotExecution?.p99Ms) + 'ms'
      + ' | ' + bytes(runtime.resPeakMemoryBytes) + ' |');
    if (tier.error) lines.push('| 失败原因 | ' + tier.error.replaceAll('|', '\\|') + ' | | | | | | | | | | |');
  }
  lines.push('', '## 验收判断', '');
  for (const item of report.acceptance) lines.push('- ' + (item.passed ? 'PASS' : 'FAIL') + ' ' + item.label + '：' + item.detail);
  if (report.error) lines.push('', '## 运行错误', '', '```text', report.error, '```');
  lines.push('', '## 已知边界', '',
    '- API 基准使用隔离 JSON 存储，不能替代 PostgreSQL 的生产规模验证。',
    '- 热执行指标包含本机 HTTP 往返，因此比纯 RES 引擎时间更保守。',
    '- 大型决策表超过 500 个启用行后跳过同步二次方冲突分析并返回警告，完整分析应进入后续离线任务。',
    '- 原始数据见同名 JSON 文件，可用于优化前后对比。', '');
  return lines.join('\n') + '\n';
}

async function writeReport(report) {
  await fs.mkdir(outputDir, { recursive: true });
  const json = JSON.stringify(report, null, 2) + '\n';
  const reportPath = path.join(outputDir, stamp + '.md');
  await fs.writeFile(path.join(outputDir, stamp + '.json'), json);
  await fs.writeFile(reportPath, markdown(report));
  await fs.writeFile(path.join(outputDir, 'latest.json'), json);
  await fs.writeFile(path.join(outputDir, 'latest.md'), markdown(report));
  return reportPath;
}

async function main() {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rules-capacity-'));
  const report = {
    schemaVersion: 1, generatedAt: new Date().toISOString(), sizes, quick,
    environment: {
      platform: process.platform, arch: process.arch, node: process.version,
      cpus: os.cpus().length, memoryBytes: os.totalmem(),
    },
    status: 'running', tiers: [], acceptance: [], conclusion: '',
  };
  let frontend;
  try {
    await fs.mkdir(outputDir, { recursive: true });
    await buildRuntimeImages();
    const apiPort = await freePort();
    frontend = await startFrontend(apiPort);
    for (const size of sizes) {
      process.stdout.write('\n[capacity] ' + size.toLocaleString() + ' 档开始\n');
      const tier = { size, status: 'running' };
      try {
        const bom = defaultBom();
        const table = capacityTable(size);
        let started = performance.now();
        const validation = validateTable(table, bom);
        const validationMs = performance.now() - started;
        tier.validation = { error: validation.error, warnings: validation.warnings, durationMs: validationMs };
        started = performance.now();
        const tableText = tableDrl(table, bom, 'capacity-table-' + size);
        const tableGenerationMs = performance.now() - started;
        started = performance.now();
        const groupText = generateDrl(Array.from({ length: size }, (_, index) => capacityRule(index)), bom);
        const ruleGroupGenerationMs = performance.now() - started;
        tier.generation = {
          tableGenerationMs, tableDrlBytes: Buffer.byteLength(tableText),
          ruleGroupGenerationMs, ruleGroupDrlBytes: Buffer.byteLength(groupText),
        };
        tier.controlPlane = await benchmarkControlPlane(size, temporaryRoot, frontend.url, apiPort);
        tier.runtime = await benchmarkRuntime(size, tableText, groupText);
        tier.status = tier.runtime.status === 'failed' || tier.controlPlane.browser.status === 'failed' ? 'failed' : 'ok';
      } catch (error) {
        tier.status = 'failed';
        tier.error = error.stack || error.message;
        process.stderr.write('[capacity] ' + size.toLocaleString() + ' 档失败：' + error.message + '\n');
      }
      report.tiers.push(tier);
      process.stdout.write('[capacity] ' + size.toLocaleString() + ' 档完成（' + tier.status + '）\n');
    }
    for (const tier of report.tiers) {
      const projectApi = tier.controlPlane?.projectApi;
      const browser = tier.controlPlane?.browser;
      const runtime = tier.runtime;
      report.acceptance.push({
        label: tier.size.toLocaleString() + ' 资产 API P95 < 500ms',
        passed: projectApi?.p95Ms != null && projectApi.p95Ms < 500,
        detail: projectApi?.p95Ms == null ? tier.error || '未完成' : fixed(projectApi.p95Ms) + 'ms',
      });
      report.acceptance.push({
        label: tier.size.toLocaleString() + ' 普通搜索交互 < 300ms',
        passed: browser?.status === 'ok' && browser.searchMs < 300,
        detail: browser?.status === 'ok' ? fixed(browser.searchMs) + 'ms' : browser?.error || browser?.reason || tier.error || '未完成',
      });
      report.acceptance.push({
        label: tier.size.toLocaleString() + ' 热执行 P95 < 50ms',
        passed: runtime?.status === 'ok' && runtime.hotExecution?.p95Ms != null && runtime.hotExecution.p95Ms < 50,
        detail: runtime?.hotExecution?.p95Ms == null ? runtime?.error || runtime?.status || tier.error || '未完成' : fixed(runtime.hotExecution.p95Ms) + 'ms',
      });
    }
    const failed = report.acceptance.filter(item => !item.passed).length;
    report.status = failed ? 'completed-with-failures' : 'completed';
    report.conclusion = failed
      ? '基准已完整执行，但 ' + failed + ' 项目标未达到；结果用于驱动后续规模化改造，不能宣称容量目标已通过。'
      : '全部已定义容量目标通过；仍需在 PostgreSQL 和生产规格硬件上复验后作为正式容量承诺。';
    const reportPath = await writeReport(report);
    process.stdout.write('\n[capacity] 报告：' + path.relative(ROOT, reportPath) + '\n');
    if (failed) process.exitCode = 1;
  } catch (error) {
    report.status = 'failed';
    report.error = error.stack || error.message;
    report.conclusion = '基准未完成，已记录致命错误；不能宣称容量目标已达到。';
    try {
      const reportPath = await writeReport(report);
      process.stdout.write('\n[capacity] 失败报告：' + path.relative(ROOT, reportPath) + '\n');
    } catch (writeError) {
      process.stderr.write('[capacity] 无法写入失败报告：' + (writeError.stack || writeError.message) + '\n');
    }
    throw error;
  } finally {
    await stop(frontend?.child);
    if (keepTemporary) process.stdout.write('[capacity] 临时目录保留：' + temporaryRoot + '\n');
    else await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error('[capacity] 失败：' + (error.stack || error.message));
  process.exitCode = 1;
});
