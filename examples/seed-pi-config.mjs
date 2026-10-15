// Executed by Node inside a trusted, network-disabled seed container.
// Copy only login credentials and portable preferences, never host packages/code.
import { constants, chmodSync, closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [source, destination] = process.argv.slice(2);
const marker = '.agentorg-seeded';
const own = (object, key) => Object.hasOwn(object, key);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const string = value => typeof value === 'string';
const boolean = value => typeof value === 'boolean';
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const strings = value => Array.isArray(value) && value.every(string);
const level = value => ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(value);
const record = predicate => value => object(value) && Object.values(value).every(predicate);
const fields = (value, rules) => Object.fromEntries(Object.entries(rules).filter(([key, valid]) => own(value, key) && valid(value[key])).map(([key]) => [key, value[key]]));

function portableSettings(value) {
  // Allowlist intentionally excludes resource/package declarations, hooks, MCP,
  // proxies, shell commands, host paths, trust decisions and arbitrary future keys.
  const result = fields(value, {
    defaultProvider: string, defaultModel: string, defaultThinkingLevel: level,
    modelThinkingLevels: record(level), thinkingBudgets: record(number), enabledModels: strings,
    steeringMode: v => ['all', 'one-at-a-time'].includes(v), followUpMode: v => ['all', 'one-at-a-time'].includes(v),
    transport: v => ['auto', 'sse', 'websocket', 'websocket-cached'].includes(v),
    httpIdleTimeoutMs: number, websocketConnectTimeoutMs: number,
    quietStartup: v => boolean(v) || v === 'header', enableInstallTelemetry: boolean, enableAnalytics: boolean,
  });
  const compaction = { enabled: boolean, reserveTokens: number, keepRecentTokens: number };
  if (object(value.compaction)) {
    result.compaction = fields(value.compaction, compaction);
    if (object(value.compaction.modelOverrides)) result.compaction.modelOverrides = Object.fromEntries(Object.entries(value.compaction.modelOverrides)
      .filter(([, v]) => object(v)).map(([key, v]) => [key, fields(v, { reserveTokens: number, keepRecentTokens: number })]));
  }
  if (object(value.branchSummary)) result.branchSummary = fields(value.branchSummary, { reserveTokens: number, skipPrompt: boolean });
  if (object(value.retry)) {
    result.retry = fields(value.retry, { enabled: boolean, maxRetries: number, baseDelayMs: number, maxAgentDelayMs: number });
    if (object(value.retry.provider)) result.retry.provider = fields(value.retry.provider, { timeoutMs: number, maxRetries: number, maxRetryDelayMs: number });
  }
  return result;
}

function input(file) {
  const path = join(source, 'agent', file);
  if (!existsSync(path) && !lstatMaybe(path)) return undefined;
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const metadata = fstatSync(fd);
    if (!metadata.isFile() || metadata.size > 4 * 1024 * 1024) throw new Error();
    const text = readFileSync(fd, 'utf8');
    const parsed = JSON.parse(text.replace(/^\uFEFF/, ''));
    if (!object(parsed)) throw new Error();
    return { text, parsed };
  } catch { throw new Error(`Cannot read a regular, valid ${file}; contents suppressed`); }
  finally { if (fd !== undefined) closeSync(fd); }
}
function lstatMaybe(path) {
  try { return lstatSync(path); } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}

try {
  if (!source || !destination || process.argv.length !== 4) throw new Error('Expected source Pi directory and destination volume');
  const root = lstatSync(destination);
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('Destination must be a real directory');
  const entries = readdirSync(destination);
  if (entries.includes(marker)) {
    if (!lstatSync(join(destination, marker)).isFile()) throw new Error('Invalid initialization marker');
    console.log('Volume already initialized; nothing copied. Existing volumes are never pruned automatically.');
    process.exit(0);
  }
  if (entries.length) throw new Error('Volume is not empty; refusing to overwrite it');
  const agent = lstatMaybe(join(source, 'agent'));
  if (!agent?.isDirectory() || agent.isSymbolicLink()) throw new Error('Expected a real agent directory under the source Pi directory');
  const auth = input('auth.json'), settings = input('settings.json');
  if (!auth && !settings) throw new Error('Source has neither agent/auth.json nor agent/settings.json');
  const preferences = settings ? JSON.stringify(portableSettings(settings.parsed), null, 2) + '\n' : undefined;
  const staging = join(destination, '.agentorg-seeding');
  mkdirSync(staging, { mode: 0o700 });
  try {
    if (auth) writeFileSync(join(staging, 'auth.json'), auth.text, { mode: 0o600, flag: 'wx' });
    if (preferences !== undefined) writeFileSync(join(staging, 'settings.json'), preferences, { mode: 0o600, flag: 'wx' });
    chmodSync(destination, 0o700);
    renameSync(staging, join(destination, 'agent'));
    writeFileSync(join(destination, marker), 'minimal-pi-config-v1\n', { mode: 0o600, flag: 'wx' });
  } catch (error) { rmSync(staging, { recursive: true, force: true }); throw error; }
  console.log('Volume initialized with minimal Pi configuration (credentials and portable preferences only).');
} catch (error) {
  // Do not print JSON parser errors, source values, file contents or stack traces.
  console.error(error.message?.startsWith('Cannot read a regular') || error.message?.startsWith('Source has neither') ||
    error.message?.startsWith('Expected ') || error.message?.startsWith('Volume is not empty') ||
    error.message?.startsWith('Invalid initialization') || error.message?.startsWith('Destination must')
    ? error.message : 'Pi configuration seeding failed; contents suppressed');
  process.exitCode = 1;
}
