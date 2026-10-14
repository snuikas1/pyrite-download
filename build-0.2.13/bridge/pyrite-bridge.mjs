// Pyrite bridge: the native messaging host between the extension and a local `claude`.
// Edge starts it with the calling extension's origin as the first argument and talks over
// stdin/stdout, each message a 4-byte little-endian length and then JSON. Its one kind of child is
// the deep check's (2026-10-01): a claude that may search and read the web and returns an opinion
// the extension shows apart from every row and number. Since 2026-10-02, when the claim check and
// the pair check went, one deep child is kept warm, its handshake answered, so a press pays no cold
// start; the deep check still runs one at a time. The 2-agent check (2026-10-04 to 2026-10-13) is
// gone at the owner's yes of 2026-10-13: every press runs that one child.
//
//   node pyrite-bridge.mjs chrome-extension://<id>/   the host, as Edge runs it
//   node pyrite-bridge.mjs --selftest                 PASS/FAIL lines for this machine
//
// The parts are exported for the unit tests; nothing runs on import.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, posix, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';

// The one extension allowed to start this host. install-mac.sh and install-windows.ps1 carry the
// same id, and a unit test keeps all three equal to the pinned manifest key.
export const EXTENSION_ID = 'hegfbajilkihmgclmnajpkhckogfplni';
export const ORIGIN = `chrome-extension://${EXTENSION_ID}/`;
export const HOST_NAME = 'com.pyrite.bridge';

// utils/types.ts BRIDGE_LIMITS holds the first three; a unit test keeps them equal. The unit tests
// shorten the times on their own copy of this file; nothing else changes them.
export const LIMITS = {
  frameBytes: 1024 * 1024,     // a frame from Edge longer than this is refused before any of it is held
  evidenceBytes: 50 * 1024,
  idChars: 100,
  outBytes: 1024 * 1024,       // Edge closes a host that sends a longer message
  schemaBytes: 8192,           // the schema travels as one argument, and Windows caps a command line at 32,767 characters
  handshakeMs: 30_000,         // a spare that has not answered by then counts as a death (spike D: 0.54-1.42 s)
  initMs: 10_000,              // after the handshake and the evidence, the init event came within 29 ms (spike D)
  reapMs: 10_000,              // a child still alive this long after its result is killed
  respawnMs: 1000,             // a spare that died is respawned after this
  // a deep check researches its story's facts until each is settled (2026-10-01, later): 12 lookups,
  // room for an answer after the last one in turns, and 3 minutes. A thorough check (DEEP_LOOKUPS)
  // keeps the same room in turns and the same time per lookup.
  deepMs: 180_000,             // a 12-lookup deep check with no result by then is killed
  deepTurns: 16,               // a 12-lookup deep child's --max-turns
  deepLookups: 12,             // web searches and page reads an ordinary deep check is allowed
};

// The lookup limits a deep check may name (2026-10-02, the owner: "add this as a selectable feature"): 12,
// or 24 when the popup's "Thorough research" switch is on. utils/types.ts DEEP_LOOKUP_LIMITS holds the
// same two; a unit test keeps them equal. The extension states the limit in the input as well, so the
// prompt names no number of its own.
export const DEEP_LOOKUPS = [12, 24];
// 16 turns for 12 lookups and 28 for 24: the same four turns of room for an answer after the last one
export const deepTurns = (lookups) => lookups + LIMITS.deepTurns - LIMITS.deepLookups;
// 3 minutes for 12 lookups and 6 for 24
export const deepTime = (lookups) => (LIMITS.deepMs * lookups) / LIMITS.deepLookups;
const HOUR = 60 * 60 * 1000;
const YEAR = 366 * 24 * HOUR;

// A spare prints nothing until it is spoken to, so readiness is asked for: the stream-json
// `initialize` request is answered once the CLI has booted and read its login (spike D).
export const HANDSHAKE = { type: 'control_request', request_id: 'ready', request: { subtype: 'initialize' } };

// ---------- config ----------

// Written by the installer into Pyrite's own folder, beside the cwd, so that bridge/ holds nothing
// of this machine: absolute paths and the pinned model live there, never in this file. A config
// written before 2026-10-02 also names the claim check's effort and the pair check's model and
// effort, and one from the 2-agent check (2026-10-04 to 2026-10-13) may name a deepMode; nothing reads
// them now, so a config that names split or topic runs the single child. The live
// test harness names its own file with PYRITE_CONFIG, so its runs never touch an installed bridge.
export function configPath(env = process.env, platform = process.platform) {
  if (env.PYRITE_CONFIG) return env.PYRITE_CONFIG;
  if (platform === 'win32') return win32.join(env.LOCALAPPDATA ?? win32.join(homedir(), 'AppData', 'Local'), 'Pyrite', 'config.json');
  return posix.join(homedir(), 'Library', 'Application Support', 'Pyrite', 'config.json');
}

export function readConfig(file) {
  try {
    // Windows PowerShell 5.1 writes UTF-8 with a byte-order mark, which JSON.parse refuses
    return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

// An alias or a model id. It may not start with '-', which claude would read as a flag.
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._[\]-]{0,63}$/;

// Null when the config is usable, else what is wrong: the detail of the 'error' state.
export function configProblem(c) {
  const absolute = process.platform === 'win32' ? win32.isAbsolute : posix.isAbsolute;
  if (!c || typeof c !== 'object') return 'config missing';
  if (typeof c.node !== 'string' || !absolute(c.node)) return 'config: node path';
  // a .cmd, .bat or .ps1 shim runs through a shell, and shell:false is what keeps evidence out of one
  if (typeof c.claude !== 'string' || !absolute(c.claude) || /\.(cmd|bat|ps1)$/i.test(c.claude)) return 'config: claude path';
  if (typeof c.cwd !== 'string' || !absolute(c.cwd)) return 'config: cwd';
  if (typeof c.model !== 'string' || !MODEL.test(c.model)) return 'config: model';
  if (c.maxThinkingTokens !== undefined && !(Number.isSafeInteger(c.maxThinkingTokens) && c.maxThinkingTokens >= 0)) return 'config: maxThinkingTokens';
  return null;
}

// Everything the host needs from disk, read once at start: the config, and the deep child's prompt
// path and minified schema from utils/claude, made into its arguments. `problem` is set instead when
// any of it is unusable: the deep check is the bridge's only work, so a missing prompt or schema is
// the whole bridge's 'error'.
export function loadSetup(here, file = configPath()) {
  const config = readConfig(file);
  const problem = configProblem(config);
  if (problem) return { problem };
  const promptPath = join(here, '..', 'utils', 'claude', 'deep-system-prompt.md');
  if (!existsSync(promptPath)) return { problem: 'deep prompt missing' };
  let schema;
  try {
    schema = JSON.stringify(JSON.parse(readFileSync(join(here, '..', 'utils', 'claude', 'deep-schema.json'), 'utf8')));
  } catch {
    return { problem: 'deep schema missing' };
  }
  if (Buffer.byteLength(schema) > LIMITS.schemaBytes) return { problem: 'deep schema over 8 KB' };
  // `args` is the ordinary check's command line, the self-test's; `argsFor` gives each limit's
  return { config, args: deepArgs(config, promptPath, schema), argsFor: (lookups) => deepArgs(config, promptPath, schema, lookups), env: childEnv(config) };
}

// ---------- the child ----------

// The deep child prints its answer as it writes it (2026-10-02): the StructuredOutput call's input
// arrives in pieces, as stream events, and each story fact in it goes to the extension as its closing
// brace arrives (itemStream). The flag changes what the child prints, never what it may do.
export const PARTIAL_FLAG = '--include-partial-messages';

// The deep child, isolated: no MCP servers, no session written to disk, the pinned model, prompt and
// schema (PLAN.md, Claude bridge), and web search and page reads as its only tools beside
// StructuredOutput. Every lookup is a permission prompt that the CLI sends here over stdio, and
// the bridge answers each one (lookupRefusal), so a page cannot steer a read to this machine, its
// network or an address that carries the account's email. --restricted drops WebFetch unless
// --tools names it, and --max-turns bounds the research, by the check's lookup limit.
export const DEEP_TOOLS = ['WebSearch', 'WebFetch'];
// At low effort research stopped at two lookups with every story fact unclear (Snoopy, 2026-10-01); a
// deep check is pressed for depth, so it thinks at high, whatever effort a config names.
export const DEEP_EFFORT = 'high';

export function deepArgs(config, promptPath, schema, lookups = LIMITS.deepLookups) {
  return [
    '-p', '--safe-mode', '--restricted', '--strict-mcp-config', '--tools', DEEP_TOOLS.join(','), '--no-session-persistence',
    '--permission-prompt-tool', 'stdio', '--max-turns', String(deepTurns(lookups)),
    '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', PARTIAL_FLAG,
    '--model', config.model, '--effort', DEEP_EFFORT,
    '--system-prompt-file', promptPath, '--json-schema', schema,
  ];
}

// The child sees nothing of this machine's environment beyond what it needs to run and find its
// login, plus the switches that keep CLAUDE.md, memory and claude.ai MCP servers out.
const ENV_KEEP = ['PATH', 'HOME', 'USERPROFILE', 'USER', 'TMPDIR', 'TEMP', 'SystemRoot', 'LANG'];

// Windows also needs these for claude.exe to find its own folders, its temp space, its shell and
// Git Bash. None carries a key or a token.
const WIN_KEEP = [
  'LOCALAPPDATA', 'APPDATA', 'TMP', 'PATHEXT', 'ComSpec', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'ProgramData',
  'SystemDrive', 'windir', 'USERNAME', 'COMPUTERNAME', 'HOMEDRIVE', 'HOMEPATH', 'CLAUDE_CODE_GIT_BASH_PATH',
];

export function childEnv(config, env = process.env, platform = process.platform) {
  const out = {};
  if (platform === 'win32') {
    // Windows names PATH "Path", and process.env ignores case only on lookup, not in its keys:
    // match every name without case and keep it as spelled
    const keep = new Set([...ENV_KEEP, ...WIN_KEEP].map((k) => k.toLowerCase()));
    for (const k of Object.keys(env)) if (keep.has(k.toLowerCase()) && env[k] !== undefined) out[k] = env[k];
  } else {
    for (const k of ENV_KEEP) if (env[k] !== undefined) out[k] = env[k];
  }
  out.CLAUDE_CODE_DISABLE_CLAUDE_MDS = '1';
  out.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1';
  out.ENABLE_CLAUDEAI_MCP_SERVERS = 'false';
  // Haiku thinks at any effort; the model pick turns thinking off this way (amendment B.10)
  if (config.maxThinkingTokens !== undefined) out.MAX_THINKING_TOKENS = String(config.maxThinkingTokens);
  return out;
}

export function spawnOptions(cwd, env) {
  // detached makes a POSIX child the leader of its own process group, so a kill takes whatever it
  // started as well. Windows kills the tree with taskkill instead; there detached would open a console.
  return { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true, detached: process.platform !== 'win32' };
}

export function killTree(pid, run = spawnSync) {
  if (pid === undefined) return;
  if (process.platform === 'win32') {
    // the full path, so nothing earlier on PATH can stand in for taskkill
    const taskkill = win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
    run(taskkill, ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 5000 });
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
}

// The one line the extension's data becomes on the child's stdin. JSON.stringify escapes \n and
// \r, so text in the evidence can never start a second line of its own. NEL, U+2028 and U+2029
// are escaped as well, for any reader that splits lines on them. A second line would be obeyed:
// stream-json input takes control requests, and a `bash_command` line runs a shell with no model.
export function userLine(evidence) {
  return stdinLine({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: evidence }] } });
}

// Any line the bridge writes to a child: the user message, and the deep child's permission answers,
// which echo its request id.
function stdinLine(msg) {
  return JSON.stringify(msg).replace(/[\u0085\u2028\u2029]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`) + '\n';
}

// ---------- isolation (amendment B.2) ----------

// The init event names skills and agents without saying where they came from, so the only sign
// that a child loaded the user's own is a name that exists in the user's folders. The names are
// read here at every start and never written anywhere.
export function userNames(home = homedir()) {
  const skills = new Set();
  const agents = new Set();
  collectSkills(join(home, '.claude', 'skills'), 2, skills);
  collectAgents(join(home, '.claude', 'agents'), 2, agents);
  return { skills, agents };
}

// A skill is a folder, named by its SKILL.md or else by the folder; a folder without a SKILL.md
// may hold more of them, as a synced bucket does.
function collectSkills(dir, depth, out) {
  for (const name of list(dir)) {
    const path = join(dir, name);
    if (!isDir(path)) continue;
    out.add(name);
    const file = join(path, 'SKILL.md');
    if (existsSync(file)) addFrontmatterName(file, out);
    else if (depth > 0) collectSkills(path, depth - 1, out);
  }
}

// An agent is a markdown file, named by its frontmatter or else by the file.
function collectAgents(dir, depth, out) {
  for (const name of list(dir)) {
    const path = join(dir, name);
    if (isDir(path)) {
      if (depth > 0) collectAgents(path, depth - 1, out);
    } else if (name.endsWith('.md')) {
      out.add(name.slice(0, -3));
      addFrontmatterName(path, out);
    }
  }
}

function list(dir) {
  try { return readdirSync(dir); } catch { return []; }
}

function isDir(path) {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

function addFrontmatterName(file, out) {
  let head;
  try { head = readFileSync(file, 'utf8').slice(0, 4096); } catch { return; }
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(head);
  const name = block && /^name:\s*["']?([^"'\r\n]+?)["']?\s*$/m.exec(block[1]);
  if (name) out.add(name[1]);
}

// A plugin's skills and agents arrive as "plugin:name"; the part after the colon is compared too.
function userHits(kind, names, user) {
  if (!Array.isArray(names)) return [`${kind}s missing`];
  const bare = (n) => n.slice(n.lastIndexOf(':') + 1);
  return names.filter((n) => typeof n !== 'string' || user.has(n) || user.has(bare(n))).map((n) => `${kind} ${n}`);
}

// The model is held to the config only when the config names it by id: an alias such as 'sonnet'
// moves with the CLI. The CLI may report an id with its snapshot date (claude-haiku-4-5-20251001),
// and a context suffix such as [1m] names the same model.
export function pinnedModel(config) {
  return typeof config?.model === 'string' && config.model.startsWith('claude-') ? config.model : null;
}

export function sameModel(pinned, seen) {
  if (typeof seen !== 'string') return false;
  const base = (m) => m.replace(/\[[^\]]*\]$/, '');
  const p = base(pinned);
  const s = base(seen);
  return s === p || (s.startsWith(`${p}-`) && /^\d{8}$/.test(s.slice(p.length + 1)));
}

// What is wrong with a child's system/init event; empty means isolated. Every field is required,
// so a CLI update that renames one fails closed and shows up in the self-test. `builtin` holds the
// names this child's own handshake marked as Claude Code's (see builtinNames), `pinned` the model
// id the config pins, if any, and `tools` the child's exact tool set, in any order.
export const DEEP_INIT_TOOLS = [...DEEP_TOOLS, 'StructuredOutput'];

export function isolationProblems(init, user, builtin = new Set(), pinned = null, tools = DEEP_INIT_TOOLS) {
  if (!init || typeof init !== 'object') return ['no init event'];
  const problems = [];
  const same = Array.isArray(init.tools) && init.tools.length === tools.length && [...init.tools].sort().join('\n') === [...tools].sort().join('\n');
  if (!same) problems.push(`tools ${JSON.stringify(init.tools)}`);
  if (!Array.isArray(init.mcp_servers) || init.mcp_servers.length > 0) {
    problems.push(`mcp_servers ${JSON.stringify(Array.isArray(init.mcp_servers) ? init.mcp_servers.map((s) => s?.name ?? s) : init.mcp_servers)}`);
  }
  if (init.apiKeySource !== 'none') problems.push(`apiKeySource ${JSON.stringify(init.apiKeySource)}`);
  if (!Array.isArray(init.plugins)) problems.push('plugins missing');
  else for (const p of init.plugins) if (typeof p?.source !== 'string' || !p.source.endsWith('@builtin')) problems.push(`plugin ${JSON.stringify(p?.source ?? p)}`);
  const skills = Array.isArray(init.skills) ? init.skills.filter((n) => !builtin.has(n)) : init.skills;
  problems.push(...userHits('skill', skills, user.skills), ...userHits('agent', init.agents, user.agents));
  if (pinned !== null && !sameModel(pinned, init.model)) problems.push(`model ${JSON.stringify(init.model)}, not ${pinned}`);
  return problems;
}

// The same checks, run on the handshake's reply before the spare is called ready: its commands
// include every skill, and it lists the agents. The init event stays the gate, so a reply without
// these lists passes here. The reply also says where a command came from: `builtin` is true for
// Claude Code's own and absent for one a user, project, plugin or MCP server defined. While the CLI
// marks any command, the marker decides, and the name rule runs only on unmarked commands: a user
// skill that shares a built-in's name is not loaded under --safe-mode, and failing on the name
// alone would keep Claude off until the skill was renamed. A CLI that marks nothing is judged on
// names alone. CLI_UNMARKED holds Claude Code's own commands that a release left unmarked: 2.1.285
// ships `diff` ("Toggle the diff panel showing uncommitted changes") without it, which kept Claude
// off (2026-09-30).
const CLI_UNMARKED = new Set(['diff']);

export function handshakeProblems(reply, user) {
  const commands = Array.isArray(reply?.commands) ? reply.commands : [];
  const names = (xs) => (Array.isArray(xs) ? xs.map((x) => x?.name) : []);
  const marked = commands.some((c) => c?.builtin === true);
  const unmarked = commands.filter((c) => c?.builtin !== true);
  const added = marked ? unmarked.filter((c) => !CLI_UNMARKED.has(c?.name)).map((c) => `command ${c?.name} not built in`) : [];
  return [...added, ...userHits('skill', names(unmarked), user.skills), ...userHits('agent', names(reply?.agents), user.agents)];
}

// The names a child's handshake marked as Claude Code's own. Its init event lists skills by name
// only, so these are exempt there from the rule on the user's names.
export function builtinNames(reply) {
  const commands = Array.isArray(reply?.commands) ? reply.commands : [];
  return new Set(commands.filter((c) => c?.builtin === true && typeof c.name === 'string').map((c) => c.name));
}

// A child's handshake reply, read once for the host and the self-test alike:
// whether the child refused, the isolation problems the reply shows, the names it marked built in,
// and its account, with whether that login has no plan (an account with no subscriptionType would
// bill an API account). null: the event is not the handshake's reply.
function readHandshake(ev, user) {
  if (ev.type !== 'control_response' || ev.response?.request_id !== HANDSHAKE.request_id) return null;
  if (ev.response.subtype !== 'success') return { refused: true };
  const reply = ev.response.response ?? {};
  const account = reply.account && typeof reply.account === 'object' ? reply.account : null;
  return {
    refused: false, problems: handshakeProblems(reply, user), builtin: builtinNames(reply),
    account, noPlan: account !== null && typeof account.subscriptionType !== 'string',
  };
}

const isInit = (ev) => ev.type === 'system' && ev.subtype === 'init';

// ---------- what a child's events mean ----------

const AUTH_ERRORS = new Set(['authentication_failed', 'oauth_org_not_allowed', 'account_on_hold', 'verification_required', 'billing_error']);
// the CLI's own wording: "Not logged in · Please run /login", "OAuth token revoked", "Login expired",
// "Failed to authenticate: OAuth session expired and could not be refreshed" (seen on Windows 2026-10-12)
export const AUTH_TEXT = /\/login|not logged in|invalid api key|oauth token|oauth session expired|failed to authenticate|login expired/i;
// "You've hit your session limit · resets 5pm", "usage limit reached". Wide on purpose (Step 8d):
// the CLI's exact limit text has not been seen. Since 2026-09-30 it only names why that one coin
// failed; nothing is held, and the next coin is asked as usual.
const LIMIT_TEXT = /you've hit your|usage limit reached|out of extra usage|limit|rate ?limit|usage|reset|429/i;

// A finished child's result event, read with what the child said before it: `seen.error` from an
// assistant event, `seen.rateLimit` from the rate-limit event. Either the output to forward, or
// the reason its check failed and whether the login needs the user.
export function outcome(ev, seen = {}) {
  if (ev.subtype === 'error_max_structured_output_retries') return { reason: 'unreadable' };
  if (!ev.is_error && ev.subtype === 'success') {
    return ev.structured_output == null ? { reason: 'unreadable' } : { output: ev.structured_output };
  }
  // an API error arrives as subtype 'success' with is_error set and the CLI's message as the result
  const text = typeof ev.result === 'string' ? ev.result : '';
  if (AUTH_ERRORS.has(seen.error) || ev.api_error_status === 401 || AUTH_TEXT.test(text)) return { reason: 'auth needed', auth: true };
  if (seen.error === 'rate_limit' || seen.rateLimit?.status === 'rejected' || ev.api_error_status === 429 || LIMIT_TEXT.test(text)) {
    return { reason: 'limit reached' };
  }
  if (Number.isInteger(ev.api_error_status)) return { reason: `claude error (http ${ev.api_error_status})` };
  return { reason: ev.subtype && ev.subtype !== 'success' ? `claude error (${ev.subtype})` : 'claude error' };
}

// A deep child that used up its --max-turns without an answer says so in its own subtype.
export function deepOutcome(ev, seen = {}) {
  return ev.subtype === 'error_max_turns' ? { reason: 'max turns' } : outcome(ev, seen);
}

// ---------- the deep child's lookups ----------

// Why the bridge refuses one lookup the deep child asks permission for, or null to allow it:
// 'isolation' for a tool it was never given. `used` counts the lookups this check already had,
// `limit` is the check's own (DEEP_LOOKUPS), and `email` is the account's, from the child's
// handshake, lower case, or null. The refusal goes back to the child as its tool's answer, so it
// words the reason for Claude.
export function lookupRefusal(req, used, email, limit = LIMITS.deepLookups) {
  const tool = req?.tool_name;
  if (!DEEP_TOOLS.includes(tool)) return 'isolation';
  const input = req.input !== null && typeof req.input === 'object' ? req.input : {};
  if (used >= limit) return 'the lookup limit is reached; answer with what you have';
  if (email !== null && carries(JSON.stringify(input).toLowerCase(), email)) return 'it carries account details';
  if (tool === 'WebSearch') return typeof input.query === 'string' && input.query.trim() !== '' && input.query.length <= 300 ? null : 'a search needs a short query';
  return urlRefusal(input.url);
}

// The whole address, or its name alone when that is long enough to be the owner's own (a URL
// writes the @ as %40).
function carries(text, email) {
  const name = email.slice(0, email.indexOf('@'));
  return text.includes(email) || (name.length >= 6 && text.includes(name));
}

// Only public web pages: http(s) on the default port, no login in the address, and a host name
// that is neither an IP address nor a name that stays on this machine or its network. The URL
// parser already writes every IPv4 form (0x7f.1, 2130706433) as dotted digits. A public name that
// resolves to a private address is not caught here.
const LOCAL_NAME = /(^|\.)(localhost|local|localdomain|internal|intranet|lan|home|corp|arpa|test|invalid|onion)$/;

export function urlRefusal(raw) {
  let u;
  try { u = typeof raw === 'string' && raw.length <= 2048 ? new URL(raw) : null; } catch { u = null; }
  if (u === null || (u.protocol !== 'https:' && u.protocol !== 'http:')) return 'not a web address';
  if (u.username !== '' || u.password !== '') return 'an address with a login in it';
  if (u.port !== '') return 'an address on another port';
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (host.startsWith('[') || /^[\d.]+$/.test(host) || !host.includes('.') || LOCAL_NAME.test(host)) return 'not a public site';
  return null;
}

// The CLI result's own usage and duration, for the scan log (Step 8d): null where it gave none.
export function resultUsage(ev) {
  const n = (x) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : null);
  const u = ev?.usage && typeof ev.usage === 'object' ? ev.usage : null;
  const use = { ms: n(ev?.duration_ms), tokensIn: n(u?.input_tokens), tokensOut: n(u?.output_tokens), cacheRead: n(u?.cache_read_input_tokens), cacheWrite: n(u?.cache_creation_input_tokens) };
  return Object.values(use).every((v) => v === null) ? null : use;
}

// The rate-limit event wraps its fields in `rate_limit_info` (read from the 2.1.281 binary, and
// seen on every live result). Its windows become the result's planUsage (amendment B.14):
// utilization is a fraction of the window (0.81 is 81%), and resetsAt goes out in ms epoch, like
// every other time the extension reads. status passes as the CLI sent it: allowed,
// allowed_warning (the server's early notice; requests still run) or rejected.
export function planUsage(info) {
  if (!info || typeof info !== 'object' || typeof info.status !== 'string') return undefined;
  const w = (x) => {
    const at = resetMs(x?.resetsAt);
    return x && Number.isFinite(x.utilization) && at !== null ? { utilization: x.utilization, resetsAt: at } : null;
  };
  return { status: info.status, fiveHour: w(info.unifiedWindows?.five_hour), sevenDay: w(info.unifiedWindows?.seven_day) };
}

// The CLI writes resetsAt in epoch seconds; milliseconds pass through. A time more than a year
// out is dropped: the child's data must not put a date no Date can hold into planUsage.
export function resetMs(x, now = Date.now()) {
  if (typeof x !== 'number' || !Number.isFinite(x) || x <= 0) return null;
  const ms = x < 1e12 ? x * 1000 : x;
  return ms <= now + YEAR ? ms : null;
}

// ---------- the answer as Claude writes it (2026-10-02) ----------

// A deep answer's lists, each sent up to the place the extension's reader stops at (utils/claude/deep.ts:
// 4 times DEEP_CAP.facts): its story facts. Its opinions on Pyrite's claims are not sent: the input
// lists none since the claim check went (2026-10-02). Its red flags are words, not objects, and come
// with the answer.
export const STREAM_DEEP = { facts: 24 };

// Reads the StructuredOutput call's input as its JSON arrives in pieces, and hands back each element
// of the top-level arrays `lists` names, parsed on its own, once the element's last character is in,
// with the list it is in. Only an object is handed back, at its place in its list: a place counts every
// element, whatever it holds, so it is the index the answer itself will give it. Nothing is ever handed
// back from half an element: a piece is only scanned, and an element is parsed only once it has closed.
// Each list is read once, and the reading ends when all of them have closed. Text that breaks the JSON
// (a closer with nothing open) ends it too; what was handed back stands, and the answer decides.
export function itemStream(lists) {
  let text = '';
  let at = 0;            // the next character to scan
  let depth = 0;         // braces and brackets open
  let str = false;       // inside a string, which started at strAt
  let esc = false;
  let strAt = 0;
  let last = '';         // the last string closed at depth 1: the key, once a colon follows it
  let key = null;        // the key whose value depth 1 is reading
  let list = null;       // the list depth 2 is inside, by its key
  const read = new Set();  // the lists already read to their end
  const places = new Map();
  let start = -1;        // where the element being read began, inside the list
  let scalar = false;    // that element is a string, number or literal
  let done = false;
  const element = (end, out) => {
    const at0 = start;
    start = -1;
    scalar = false;
    const index = places.get(list) ?? 0;
    places.set(list, index + 1);
    if (text[at0] !== '{') return;
    try {
      const item = JSON.parse(text.slice(at0, end));
      if (item !== null && typeof item === 'object' && !Array.isArray(item)) out.push({ list, index, item });
    } catch { /* not JSON: nothing is handed back for it */ }
  };
  return (piece) => {
    const out = [];
    if (done || typeof piece !== 'string') return out;
    text += piece;
    for (; at < text.length && !done; at++) {
      const ch = text[at];
      if (str) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') {
          str = false;
          if (depth === 1) last = text.slice(strAt + 1, at);
          if (list !== null && depth === 2 && scalar) element(at + 1, out);
        }
        continue;
      }
      if (ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t') continue;
      if (list !== null && depth === 2 && start < 0 && ch !== ',' && ch !== ']') {
        start = at;
        scalar = ch !== '{' && ch !== '[';
      }
      if (ch === '"') {
        str = true;
        strAt = at;
      } else if (ch === '{' || ch === '[') {
        if (depth === 1 && ch === '[' && lists.includes(key) && !read.has(key)) list = key;
        depth++;
      } else if (ch === '}' || ch === ']') {
        // a literal or number ends at the closer after it
        if (list !== null && depth === 2 && scalar) element(at, out);
        depth--;
        if (depth < 0) done = true;
        else if (list !== null && depth === 2 && start >= 0) element(at + 1, out);
        else if (list !== null && depth === 1) {
          read.add(list);
          list = null;
          done = read.size === lists.length;
        }
      } else if (ch === ':' && depth === 1) {
        key = last;
      } else if (ch === ',') {
        if (depth === 1) key = null;
        if (list !== null && depth === 2 && scalar) element(at, out);
      }
    }
    return out;
  };
}

// ---------- what a deep check shows while it runs (2026-10-02) ----------

// The owner's "can the deepsearch claimes apear 1 by 1?": while the deep child researches, each lookup
// the bridge allowed goes to the extension as one short line: a search's query, or a page's site and
// the first step of its path, never the rest of its address. A lookup the bridge refused shows nothing.
export const STEP_CHARS = 100;

function cut(s, max) {
  const chars = [...s.replace(/\s+/g, ' ').trim()];
  return chars.length <= max ? chars.join('') : `${chars.slice(0, max - 1).join('').trimEnd()}…`;
}

// An allowed lookup's line: a search's query, or a page's host without its www., the first step of its
// path, and "/…" where more of the path follows. Only a lookup lookupRefusal allowed comes here, so its
// query is a string and its url a public web address.
export function lookupStep(req) {
  const input = req.input;
  if (req.tool_name === 'WebSearch') return { kind: 'search', text: cut(input.query, STEP_CHARS) };
  const u = new URL(input.url);
  const steps = u.pathname.split('/').filter((s) => s !== '');
  let first = steps[0] ?? '';
  try { first = decodeURIComponent(first); } catch { /* shown as it was written */ }
  const host = u.hostname.toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
  const path = steps.length === 0 ? '' : `/${cut(first, 40)}${steps.length > 1 ? '/…' : ''}`;
  return { kind: 'read', text: cut(`${host}${path}`, STEP_CHARS) };
}

// ---------- the native messaging port ----------

export function frame(msg) {
  const body = Buffer.from(JSON.stringify(msg), 'utf8');
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  return Buffer.concat([head, body]);
}

// Frames over 1 MB are refused before any of their body is held: the length is read, and the
// body's bytes are dropped as they stream past. A body that is not JSON is dropped.
export function frameReader(onMessage, onRefused) {
  let pending = Buffer.alloc(0);
  let skip = 0;
  return (chunk) => {
    if (skip) {
      const n = Math.min(skip, chunk.length);
      skip -= n;
      chunk = chunk.subarray(n);
    }
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    while (pending.length >= 4) {
      const len = pending.readUInt32LE(0);
      if (len > LIMITS.frameBytes) {
        const have = Math.min(pending.length - 4, len);
        skip = len - have;
        pending = pending.subarray(4 + have);
        onRefused();
        continue;
      }
      if (pending.length < 4 + len) break;
      const body = pending.subarray(4, 4 + len);
      pending = pending.subarray(4 + len);
      let msg;
      try { msg = JSON.parse(body.toString('utf8')); } catch { continue; }
      onMessage(msg);
    }
  };
}

const isId = (x) => typeof x === 'string' && x.length > 0 && x.length <= LIMITS.idChars;

// The closed protocol: these four shapes, key for key, and nothing else is acted on. A deep check
// carries its input as `evidence` and its lookup limit as `lookups` (2026-10-02). A deep check whose
// limit is not one of DEEP_LOOKUPS, or that names none (an extension from before the limit), comes back
// as `refused` with its id, so it is answered rather than left waiting. An extension from 2026-10-05 to
// 2026-10-13 also names its `agents`, 1 or 2: still read, so that copy is answered, and run as the one
// child either way (2026-10-13); any other value is refused as a bad limit is.
const OLD_AGENTS = [1, 2];
const DEEP_KEYS = new Set(['evidence,id,lookups,type', 'evidence,id,type', 'agents,evidence,id,lookups,type', 'agents,evidence,id,type']);
export function parseIn(m) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return null;
  const keys = Object.keys(m).sort().join(',');
  if ((m.type === 'on' || m.type === 'off') && keys === 'type') return m;
  if (m.type === 'deep' && DEEP_KEYS.has(keys) && isId(m.id) && typeof m.evidence === 'string') {
    return DEEP_LOOKUPS.includes(m.lookups) && (m.agents === undefined || OLD_AGENTS.includes(m.agents)) ? m : { type: 'refused', id: m.id };
  }
  if (m.type === 'cancel' && keys === 'id,type' && isId(m.id)) return m;
  return null;
}

// ---------- one claude ----------

// Starts one child as the host and the self-test both run it: the production command, the
// handshake written at once, and each stdout line handed on as a parsed event. `onClose` runs
// once, after the process and its pipes are gone, or when it never started. `setup` is loadSetup's,
// and `args` its command line for the check's lookup limit.
export function startChild(setup, onEvent, onClose, args = setup.args) {
  const c = {
    proc: null, pid: undefined, id: null, ready: false, init: null, error: null, rateLimit: null, builtin: new Set(),
    answered: false, exited: false, killed: false, closed: false, spawnError: null, text: '',
    reaper: null, deadline: null, initTimer: null, handshakeTimer: null,
  };
  // stderr and any stdout that is not JSON, kept short: the CLI prints "Please run /login" there
  const keep = (s) => { if (c.text.length < 4096) c.text += s.slice(0, 4096 - c.text.length); };
  const close = (code, signal) => {
    if (c.closed) return;
    c.closed = true;
    onClose(c, code, signal);
  };
  try {
    c.proc = spawn(setup.config.claude, args, spawnOptions(setup.config.cwd, setup.env));
  } catch (e) {
    c.spawnError = e?.code ?? 'spawn failed';
    c.exited = true;
    setImmediate(() => close(null, null));
    return c;
  }
  c.pid = c.proc.pid;
  c.proc.stdin.on('error', () => {});   // a child killed mid-write must not take the bridge down
  c.proc.stdin.write(JSON.stringify(HANDSHAKE) + '\n');
  // decoded as a stream, so a character split across two chunks cannot turn into U+FFFD inside a quote
  c.proc.stdout.setEncoding('utf8');
  let buf = '';
  c.proc.stdout.on('data', (d) => {
    buf += d;
    for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      let ev;
      try { ev = JSON.parse(line); } catch { keep(line + '\n'); continue; }
      // a killed child's last lines count for nothing
      if (ev && typeof ev === 'object' && !c.killed) onEvent(c, ev);
    }
  });
  c.proc.stderr.setEncoding('utf8');
  c.proc.stderr.on('data', keep);
  c.proc.on('error', (e) => {
    c.spawnError ??= e?.code ?? 'spawn failed';
    // a process that never started has no pipes to close
    if (c.pid === undefined) {
      c.exited = true;
      close(null, null);
    }
  });
  c.proc.on('exit', () => { c.exited = true; });
  c.proc.on('close', close);
  return c;
}

function kill(c) {
  if (!c || c.killed || c.exited) return;
  c.killed = true;
  killTree(c.pid);
}

// What a child says before its result, kept on it for outcome and planUsage: the rate-limit event
// (the popup shows the plan's usage; it holds nothing back, 2026-09-30) and an assistant's error.
// True when the event was one of these.
function noteEvent(c, ev) {
  if (ev.type === 'rate_limit_event') c.rateLimit = ev.rate_limit_info ?? null;
  else if (ev.type === 'assistant' && typeof ev.error === 'string') c.error = ev.error;
  else return false;
  return true;
}

// ---------- the host ----------

export function runHost(here) {
  const setup = loadSetup(here);
  let broken = setup.problem ?? null;   // an unusable install: 'error' until it is fixed and Edge reconnects
  if (!broken) {
    try { mkdirSync(setup.config.cwd, { recursive: true }); } catch { broken = 'cwd not writable'; }
  }
  const pinned = broken ? null : pinnedModel(setup.config);

  let on = false;
  let fatal = null;        // why deep checks are refused until the next 'on'
  let auth = null;         // why the login needs the user: 'no plan login' or 'login failed'
  let noPlan = false;      // a handshake showed a login without a plan, which would bill the API
  let spare = null;        // a deep child spawned ahead of the next press (2026-10-02)
  // the lookup limit the next spare is started for: the last press's, and at first the popup's own
  // first setting, thorough research on
  let spareLookups = DEEP_LOOKUPS[1];
  let deep = null;         // the one deep check, on a child of its own; never queued
  const retired = new Set();   // children told to exit after their result
  let spareDeaths = 0;
  let user = { skills: new Set(), agents: new Set() };
  let last = null;

  const send = (msg) => process.stdout.write(frame(msg));
  const fail = (id, reason) => send({ type: 'failed', id, reason });

  function current() {
    if (broken) return ['error', broken];
    if (!on) return ['off', null];
    if (fatal) return ['error', fatal];
    if (deep) return ['checking', deep.id];
    if (auth) return ['auth_needed', auth];
    return [spare?.ready ? 'ready' : 'warming', null];
  }

  // The state goes out whenever it changes, and on request with `again`. The effort is the deep
  // child's own, whatever the config names.
  function report(again = false) {
    const [state, detail] = current();
    const key = `${state}|${detail}`;
    if (!again && key === last) return;
    last = key;
    send({ type: 'state', state, detail, model: setup.config?.model ?? null, effort: setup.config ? DEEP_EFFORT : null });
  }

  // A deep child as every one starts: its command line and lookup guard for `limit`, its lookups
  // counted from none, and the account's email, which the lookup guard refuses to send anywhere,
  // read from its handshake.
  function startDeep(limit) {
    const c = startChild(setup, onDeepEvent, onClose, setup.argsFor(limit));
    c.limit = limit;
    c.lookups = { allowed: 0, refused: 0 };
    c.email = null;
    c.input = null;
    return c;
  }

  // The warm spare (2026-10-02), the claim check's spare kept for the deep child: spawned at 'on' and
  // after each press, its handshake held to every check a deep child's is, so the press finds it
  // ready and writes the input at once. It is given nothing until then.
  function spawnSpare() {
    if (spare || !on || fatal || broken) return;
    const c = startDeep(spareLookups);
    spare = c;
    // a spare that never answers would leave the switch at 'warming' with no error
    c.handshakeTimer = setTimeout(() => {
      if (c !== spare || c.ready) return;
      spare = null;
      spareDied(c, 'claude did not answer the handshake');
      kill(c);
    }, LIMITS.handshakeMs);
    c.handshakeTimer.unref();
  }

  // The handshake, where every deep child is held to the same checks: one that is not isolated stops
  // everything, and one on a login without a plan is never given an input. The input waits for it: a
  // press that took a spare still warming has its input written here.
  function onDeepEvent(c, ev) {
    if (c.answered || (c !== deep && c !== spare)) return;
    const h = readHandshake(ev, user);
    if (h) {
      clearTimeout(c.handshakeTimer);
      if (h.refused) {
        if (c === deep) return deepFailed(c, 'claude refused the handshake');
        spare = null;
        spareDied(c, 'claude refused the handshake');
        return kill(c);
      }
      c.ready = true;
      if (c === spare) spareDeaths = 0;
      if (h.problems.length > 0) return isolationFailed();
      c.builtin = h.builtin;
      if (h.noPlan) {
        noPlan = true;
        auth ??= 'no plan login';
        report();
        return c === deep ? deepFailed(c, 'auth needed') : undefined;
      }
      // kept only to refuse a lookup that carries it; never written anywhere
      if (typeof h.account?.email === 'string' && h.account.email.includes('@')) c.email = h.account.email.toLowerCase();
      if (c === deep) return give(c);
      return report();
    }
    // a spare says nothing more before its press: whatever else it prints counts for nothing, and its
    // init event, which comes only after its input, is read once it is the deep check's
    if (c !== deep) return;
    if (isInit(ev)) return initSeen(c, ev, pinned, DEEP_INIT_TOOLS);
    if (ev.type === 'control_request') return answerChild(c, ev);
    if (noteEvent(c, ev)) return;
    if (ev.type === 'stream_event') return deepWritten(c, ev.event);
    if (ev.type === 'result' && answer(c, ev, 'deep_result', deepOutcome, deepExtra(c))) {
      deep = null;
      report();
    }
  }

  // What a deep result carries beside the answer: the lookups.
  const deepExtra = (c) => ({ lookups: { ...c.lookups } });

  // The only thing the extension's data becomes on the child's stdin: one user message, written once
  // its handshake showed it isolated and on a plan. `holds` says whether the child still holds its check.
  function give(c, holds = () => c === deep) {
    c.proc.stdin.write(userLine(c.input));
    c.input = null;
    armInit(c, holds);
  }

  // A deep answer's story facts as Claude writes them (2026-10-02): each goes out as a `deep_item` the
  // moment its closing brace arrives. A list's items past the place the extension reads to are not sent.
  function deepWritten(c, e) {
    for (const { list, index, item } of written(c, e, deepLists)) {
      if (index < STREAM_DEEP[list]) sendStreamed({ type: 'deep_item', id: c.id, list, index, item });
    }
  }
  const deepLists = () => itemStream(Object.keys(STREAM_DEEP));

  // What a child's answer holds so far, read by the reader `open` makes: only from a child whose
  // isolation its init event showed, only until its answer, and only from the first StructuredOutput
  // call: a call the CLI refused and asked again for streams nothing more, and the answer still
  // settles everything.
  function written(c, e, open) {
    if (c.answered || !c.init || !e || typeof e !== 'object') return [];
    const s = (c.stream ??= { block: null, read: null, over: false });
    if (s.over) return [];
    if (e.type === 'content_block_start') {
      if (s.read === null && e.content_block?.type === 'tool_use' && e.content_block.name === 'StructuredOutput') {
        s.block = e.index;
        s.read = open();
      }
      return [];
    }
    if (s.read === null || e.index !== s.block) return [];
    if (e.type === 'content_block_stop') {
      s.over = true;
      return [];
    }
    if (e.type !== 'content_block_delta' || e.delta?.type !== 'input_json_delta') return [];
    return s.read(e.delta.partial_json);
  }

  // Edge drops a host that sends more than 1 MB, so a streamed piece that long is not sent; the answer still comes.
  function sendStreamed(msg) {
    if (Buffer.byteLength(JSON.stringify(msg)) <= LIMITS.outBytes) send(msg);
  }

  // The init event, where every child's isolation is judged (amendment B.2): the model against the
  // id `pinnedId` names and the tool set against `tools`.
  function initSeen(c, ev, pinnedId, tools) {
    c.init = ev;
    clearTimeout(c.initTimer);
    if (isolationProblems(ev, user, c.builtin, pinnedId, tools).length > 0) isolationFailed();
  }

  // A result, answered as a `deep_result` with `extra`, and the child retired. No result counts from a
  // child whose isolation was never seen: that stops everything, and false is returned.
  function answer(c, ev, type, read = outcome, extra = {}) {
    if (!c.init) {
      isolationFailed();
      return false;
    }
    settle(c);
    const o = read(ev, c);
    if (o.output !== undefined) {
      const usage = planUsage(c.rateLimit);
      const msg = { type, id: c.id, structured_output: o.output, ...(usage && { planUsage: usage }), usage: resultUsage(ev), ...extra };
      // Edge drops a host that sends more than 1 MB, so an oversized answer fails on its own
      if (Buffer.byteLength(JSON.stringify(msg)) > LIMITS.outBytes) fail(c.id, 'unreadable');
      else send(msg);
      auth = null;
    } else {
      fail(c.id, o.reason);
      if (o.auth) auth = 'login failed';
    }
    retire(c);
    return true;
  }

  // A check is answered once: its timers stop, so nothing later can answer it again.
  function settle(c) {
    c.answered = true;
    clearTimeout(c.deadline);
    clearTimeout(c.initTimer);
    clearTimeout(c.handshakeTimer);
  }

  // A check stopped before its answer: answered with `reason`, and its child killed.
  function drop(c, reason) {
    settle(c);
    kill(c);
    fail(c.id, reason);
  }

  // One child per check: its stdin is closed so it exits, and one that lingers is killed.
  function retire(c) {
    c.proc.stdin.end();
    retired.add(c);
    c.reaper = setTimeout(() => kill(c), LIMITS.reapMs);
    c.reaper.unref();
  }

  // Why no deep check may start now, or null.
  function refusal() {
    if (broken || fatal) return broken ?? fatal;
    if (!on) return 'off';
    // the last gate before billed tokens: a login without a plan. A plan in paid extra usage no
    // longer refuses (2026-09-30): the owner watches his plan himself.
    if (noPlan) return 'auth needed';
    return null;
  }

  // Once a child has answered its handshake and holds the input, its init event follows within
  // milliseconds. Without one nothing shows what the child can do, so it counts as not isolated.
  // `holds` says whether the child still holds its check.
  function armInit(c, holds) {
    c.initTimer = setTimeout(() => {
      if (holds() && !c.answered && !c.init) isolationFailed();
    }, LIMITS.initMs);
    c.initTimer.unref();
  }

  function cancel(id) {
    if (deep?.id === id && !deep.answered) deepFailed(deep, 'cancelled');
  }

  // ---------- the deep check ----------

  // One at a time, on the warm spare when it was started for this check's lookup limit, else on a
  // child spawned for it: the input is written only once the child's handshake has been held to every
  // check, and only to a child on a plan. Its init event must list exactly DEEP_INIT_TOOLS, or
  // everything stops as for any child that is not isolated. A new spare is spawned for the press
  // after it, for the same limit; a spare for the other limit is killed, as its --max-turns is not
  // this check's.
  function deepCheck(id, input, lookups) {
    if (Buffer.byteLength(input, 'utf8') > LIMITS.evidenceBytes) return fail(id, 'evidence over 50 KB');
    // Pyrite's deep input always opens with its own tag, and nothing else passes: the CLI acts on how
    // a message opens ('/' runs a slash command), and a later version may act on more.
    if (!/^<deep_check[\s>]/.test(input)) return fail(id, 'evidence refused');
    const why = refusal();
    if (why !== null) return fail(id, why);
    // an id names one check: a second copy could be cancelled while the first still answers
    if (deep?.id === id) return fail(id, 'duplicate id');
    if (deep) return fail(id, 'deep busy');
    if (spare !== null && spare.limit !== lookups) {
      kill(spare);
      spare = null;
    }
    spareLookups = lookups;
    const c = spare ?? startDeep(lookups);
    spare = null;
    clearTimeout(c.handshakeTimer);
    c.id = id;
    c.input = input;
    deep = c;
    if (c.ready) give(c);
    else {
      c.handshakeTimer = setTimeout(() => { if (c === deep && !c.ready) deepFailed(c, 'claude did not answer the handshake'); }, LIMITS.handshakeMs);
      c.handshakeTimer.unref();
    }
    c.deadline = setTimeout(() => { if (c === deep && !c.answered) deepFailed(c, 'timeout'); }, deepTime(lookups));
    c.deadline.unref();
    spawnSpare();
    report();
  }

  // The CLI asks the host before each lookup. Nothing is allowed before the init event showed the
  // child isolated, and a tool it was never given stops everything. Any other request is refused, so
  // the child never waits on the bridge. A lookup allowed is told to the extension as it starts
  // (lookupStep); a refused one is not.
  function answerChild(c, ev) {
    const req = ev.request;
    let response = null;
    if (req?.subtype === 'can_use_tool') {
      const why = c.init ? lookupRefusal(req, c.lookups.allowed, c.email, c.limit) : 'not before the init event';
      if (why === 'isolation') return isolationFailed();
      if (why === null) {
        c.lookups.allowed++;
        send({ type: 'deep_progress', id: c.id, ...lookupStep(req) });
      } else {
        c.lookups.refused++;
      }
      // an allow names the input it was judged on, so the lookup that runs is the one checked
      response = why === null ? { behavior: 'allow', updatedInput: req.input } : { behavior: 'deny', message: `Pyrite refused this lookup: ${why}.` };
    }
    const answer = response === null
      ? { subtype: 'error', request_id: String(ev.request_id), error: 'not supported' }
      : { subtype: 'success', request_id: String(ev.request_id), response };
    c.proc.stdin.write(stdinLine({ type: 'control_response', response: answer }));
  }

  function deepFailed(c, reason) {
    drop(c, reason);
    deep = null;
    report();
  }

  // Every start re-reads the user's skill and agent names and re-runs the isolation check on the
  // children it spawns, because claude updates itself between runs (amendment B.2).
  function turnOn() {
    const restart = !broken && (!on || fatal !== null || (auth !== null && deep === null));
    if (!restart) return report(true);
    kill(spare);
    spare = null;
    on = true;
    fatal = null;
    auth = null;
    noPlan = false;
    spareDeaths = 0;
    user = userNames();
    spawnSpare();
    report(true);
  }

  function turnOff() {
    on = false;
    if (deep && !deep.answered) {
      settle(deep);
      fail(deep.id, 'off');
    }
    for (const c of [spare, deep, ...retired]) kill(c);
    spare = deep = null;
    report(true);
  }

  // Any child that is not isolated stops everything: its check fails, every child is killed, and
  // deep checks are refused until the next 'on' starts over.
  function isolationFailed() {
    fatal = 'isolation failed';
    if (deep && !deep.answered) {
      settle(deep);
      fail(deep.id, fatal);
    }
    for (const c of [spare, deep]) kill(c);
    spare = deep = null;
    report();
  }

  function onClose(c, code, signal) {
    retired.delete(c);
    clearTimeout(c.reaper);
    clearTimeout(c.handshakeTimer);
    const exited = `claude exited (${signal ?? code})`;
    if (c === deep) {
      // a check whose child closed before its answer fails, as a login problem when its text says so
      if (!c.answered) {
        settle(c);
        if (AUTH_TEXT.test(c.text)) {
          auth = 'login failed';
          fail(c.id, 'auth needed');
        } else {
          fail(c.id, c.spawnError === 'ENOENT' ? 'claude not found' : c.spawnError ? 'spawn failed' : exited);
        }
      }
      deep = null;
      report();
    } else if (c === spare) {
      spare = null;
      spareDied(c, c.spawnError === 'ENOENT' ? 'claude not found' : exited);
    }
  }

  // A spare that dies is respawned, unless it keeps dying before it is ready, or says the user is
  // not logged in: then a respawn cannot help, and 'on' tries again. A claude that is not there counts
  // as one such death, so the moment an update swaps its file is survived.
  function spareDied(c, why) {
    if (!on || fatal || c.killed) return report();
    if (AUTH_TEXT.test(c.text)) auth = 'no plan login';
    else if (!c.ready && ++spareDeaths >= 3) fatal = why;
    else setTimeout(spawnSpare, LIMITS.respawnMs);
    report();
  }

  // Edge closing the port closes stdin: nothing may outlive the extension's connection.
  function shutdown() {
    for (const c of [spare, deep, ...retired]) kill(c);
    process.exit(0);
  }

  const read = frameReader((msg) => {
    const m = parseIn(msg);
    if (!m) return;
    if (m.type === 'on') turnOn();
    else if (m.type === 'off') turnOff();
    else if (m.type === 'deep') deepCheck(m.id, m.evidence, m.lookups);
    else if (m.type === 'refused') fail(m.id, 'lookups refused');
    else cancel(m.id);
  }, () => {
    // said once, then the state as it stands, so a 'checking' detail is never read as an id
    send({ type: 'state', state: current()[0], detail: 'refused a frame over 1 MB', model: setup.config?.model ?? null, effort: setup.config ? DEEP_EFFORT : null });
    report(true);
  });
  process.stdin.on('data', read);
  process.stdin.on('end', shutdown);
  process.stdin.on('error', shutdown);
  process.stdout.on('error', shutdown);
  process.on('SIGTERM', shutdown);
  report(true);
}

// ---------- the self-test ----------

// PASS or FAIL for each thing the host needs, run as the host would run it. Resolves true when
// every line passed.
export async function selftest(here, print = console.log) {
  let pass = true;
  const line = (ok, what, detail) => {
    pass &&= ok;
    print(`${ok ? 'PASS' : 'FAIL'} ${what}: ${detail}`);
  };
  const setup = loadSetup(here);
  if (setup.problem) {
    const why = setup.problem === 'config missing' ? 'no usable config.json' : setup.problem.replace(/^config: /, 'bad ');
    line(false, 'config', `${why}; run the installer again`);
    return false;
  }
  const { config } = setup;
  try { mkdirSync(config.cwd, { recursive: true }); } catch { /* the runs below say what fails */ }
  const run = (cmd, args) => spawnSync(cmd, args, { cwd: config.cwd, env: setup.env, encoding: 'utf8', timeout: 30_000, shell: false, windowsHide: true });

  const node = run(config.node, ['--version']);
  const major = Number(/^v(\d+)\./.exec(node.stdout ?? '')?.[1] ?? 0);
  line(node.status === 0 && major >= 20, 'node', node.status === 0 ? `${node.stdout.trim()}${major >= 20 ? '' : ', 20 or later needed'}` : 'did not run');

  const claude = run(config.claude, ['--version']);
  line(claude.status === 0, 'claude', claude.status === 0 ? claude.stdout.trim() : `did not run (${claude.error?.code ?? claude.status})${said(claude.stderr)}`);

  // Only two fields are read. The reply also carries the account's email, which is never printed.
  const status = run(config.claude, ['auth', 'status', '--json']);
  let login = null;
  try { login = JSON.parse(status.stdout); } catch { /* not JSON: not logged in, or no claude */ }
  const plan = login?.loggedIn === true && typeof login.subscriptionType === 'string' ? login.subscriptionType : null;
  line(plan !== null, 'login', plan !== null ? `${plan} plan`
    : login?.loggedIn === true ? 'logged in without a plan; run claude, then /login with the plan account'
      : 'not logged in; run claude and log in with the plan account');

  const probe = await deepProbe(setup, userNames(), plan !== null);
  line(probe.isolation.length === 0 && probe.summary !== '', 'deep isolation', probe.isolation.length > 0 ? probe.isolation.join('; ') : probe.summary || probe.detail);
  for (const [ok, what, detail] of packageChecks(here)) line(ok, what, detail);
  return pass;
}

// Chrome's and Edge's rule for an unpacked extension's ID: the SHA-256 of the manifest key's bytes,
// its first 32 hex digits, each 0-f written as a-p.
export function extensionIdOf(key) {
  const hex = createHash('sha256').update(Buffer.from(key, 'base64')).digest('hex').slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

const REGISTRATIONS = [
  ['Chrome', 'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\'],
  ['Edge', 'HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\'],
];

// The (Default) value of a key under HKCU, or null when there is none.
function regDefault(key, env = process.env) {
  const reg = win32.join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'reg.exe');
  const r = spawnSync(reg, ['query', key, '/ve'], { encoding: 'utf8', timeout: 10_000, windowsHide: true });
  return r.status === 0 ? /REG_SZ\s+(.+?)\s*$/m.exec(r.stdout)?.[1] ?? null : null;
}

// What the trial package's installer set up (Step 11a), as [ok, what, detail]: on Windows, the host
// registered for Chrome and for Edge and the app copy the registration points into; beside a shipped
// extension folder, that its manifest key gives the one pinned ID. A dev checkout has neither.
export function packageChecks(here, { platform = process.platform, env = process.env, reg = regDefault, exists = existsSync } = {}) {
  const out = [];
  const pyrite = platform === 'win32' ? win32.dirname(configPath(env, platform)) : null;
  if (pyrite !== null) {
    const manifest = win32.join(pyrite, `${HOST_NAME}.json`);
    for (const [browser, key] of REGISTRATIONS) {
      const value = reg(key + HOST_NAME, env);
      // reg.exe prints in the OEM code page, so a user name in another alphabet can come back
      // garbled: the value's own tail, with the manifest where the installer wrote it, passes too
      const ok = value !== null && exists(manifest)
        && (value.toLowerCase() === manifest.toLowerCase() || value.toLowerCase().endsWith(`\\pyrite\\${HOST_NAME}.json`));
      out.push([ok, `${browser} registration`, value === null ? 'not registered; run Install Pyrite.cmd again'
        : ok ? value : !exists(manifest) ? `${manifest} is missing; run Install Pyrite.cmd again` : `points at ${value}, not ${manifest}`]);
    }
  }
  const shipped = join(here, '..', 'extension', 'manifest.json');
  if (exists(shipped)) {
    let key = null;
    try { key = JSON.parse(readFileSync(shipped, 'utf8')).key ?? null; } catch { /* read as no key */ }
    const id = typeof key === 'string' ? extensionIdOf(key) : null;
    out.push([id === EXTENSION_ID, 'extension id', id === null ? 'the shipped manifest has no key' : id === EXTENSION_ID ? id : `${id}, not ${EXTENSION_ID}`]);
  }
  if (pyrite !== null) {
    const app = win32.join(pyrite, 'app');
    const missing = ['bridge\\pyrite-bridge.mjs', 'node\\node.exe', 'extension\\manifest.json'].filter((f) => !exists(win32.join(app, f)));
    out.push([missing.length === 0, 'app copy', missing.length === 0 ? app : `missing ${missing.join(', ')} in ${app}; run Install Pyrite.cmd again`]);
  }
  return out;
}

// The self-test's handshake step for the child it starts, as the host takes it: a child that refused,
// is not isolated or is not on a plan is stopped with why, and null comes back. Else it is sent `line`,
// and the names its reply marked built in come back.
function probeHandshake(c, h, got, onPlan, line, stop) {
  clearTimeout(c.handshakeTimer);
  if (h.refused) {
    stop(c, 'claude refused the handshake');
    return null;
  }
  got.isolation.push(...h.problems);
  if (got.isolation.length > 0) {
    stop(c, 'not run: isolation failed');
    return null;
  }
  if (!onPlan || h.noPlan) {
    stop(c, 'not run: log in with the plan account first');
    return null;
  }
  c.proc.stdin.write(userLine(line));
  return h.builtin;
}

// What an isolated child's init event showed, for the self-test's line.
function initSummary(ev, pinned) {
  return `claude ${ev.claude_code_version}, model ${ev.model}${pinned === null ? ' (not pinned by id)' : ''}: tools ${ev.tools.join(',')}, `
    + `no MCP servers, apiKeySource none, ${ev.plugins.length} plugins all built-in, ${ev.skills.length} skills and ${ev.agents.length} agents, none of them the user's`;
}

// The deep child exactly as the host starts it for an ordinary check, warm spare or not (a thorough
// check's command line differs in --max-turns alone), held to its handshake and its init event. It is sent this fixed line, never evidence, and killed the moment its init event arrives,
// which comes about 30 ms after the line and seconds before any answer or lookup could (spike D). The
// CLI may already have begun its model request by then; nothing it could say or fetch comes back.
const DEEP_PROBE = '<deep_check>Pyrite self-test. There is nothing to research.</deep_check>';

function deepProbe(setup, user, onPlan) {
  return new Promise((resolve) => {
    const got = { isolation: [], summary: '', detail: '' };
    const pinned = pinnedModel(setup.config);
    let builtin = new Set();
    let timer = null;
    let settled = false;
    const done = (c, detail = '') => {
      if (settled) return;
      settled = true;
      got.detail = detail;
      clearTimeout(timer);
      clearTimeout(c.handshakeTimer);
      kill(c);
      resolve(got);
    };
    const c = startChild(setup, (c, ev) => {
      const h = readHandshake(ev, user);
      if (h) {
        const marked = probeHandshake(c, h, got, onPlan, DEEP_PROBE, done);
        if (marked === null) return;
        builtin = marked;
        timer = setTimeout(() => done(c, 'not checked: no init event'), LIMITS.initMs);
      } else if (isInit(ev)) {
        got.isolation.push(...isolationProblems(ev, user, builtin, pinned, DEEP_INIT_TOOLS));
        if (got.isolation.length === 0) got.summary = `${initSummary(ev, pinned)}; stopped at its init event, before any answer or lookup`;
        done(c);
      } else if (ev.type === 'control_request' || ev.type === 'assistant' || ev.type === 'result') {
        done(c, `not checked: ${ev.type} before the init event`);
      }
    }, (c, code, signal) => done(c, c.spawnError ? `claude did not start (${c.spawnError})` : `claude exited (${signal ?? code}) before its init event${said(c.text)}`));
    c.handshakeTimer = setTimeout(() => done(c, 'claude did not answer the handshake'), LIMITS.handshakeMs);
  });
}

// The first line claude printed on its way out, which on a new machine is usually the reason.
function said(text) {
  const first = (text ?? '').trim().split('\n')[0]?.trim() ?? '';
  return first ? `: ${first.slice(0, 200)}` : '';
}

// ---------- entry ----------

// import.meta.main arrived in Node 24.2 and 22.18; before that, compare this file with the one Node ran
function isEntry() {
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}

if (import.meta.main ?? isEntry()) {
  const here = dirname(fileURLToPath(import.meta.url));
  if (process.argv[2] === '--selftest') {
    selftest(here).then((ok) => { process.exitCode = ok ? 0 : 1; });
  } else if (process.argv[2] === ORIGIN) {
    // Edge on Windows adds --parent-window after the origin; only the origin matters
    runHost(here);
  } else {
    process.exit(1);
  }
}
