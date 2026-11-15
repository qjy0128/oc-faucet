/**
 * 伪装层（impersonation）：让 Bun 侧车发出的请求在 zen 眼里就是一只真的桌面端 OpenCode。
 *
 * v2.2.7 真机抓包口径：
 *   1. UA 是 `opencode/latest/<版本>/desktop`，客户端头是 `x-opencode-client: desktop`；
 *   2. `x-opencode-session`(+`-id`) 使用 OpenCode 版式的 ses_ id，同会话复用；
 *   3. 不再发送 v1 的 `x-opencode-request`；
 *   4. `x-opencode-project: global`、`x-session-affinity` / `x-session-id` 与 ses_ id 一致；
 *   5. messages[0] 使用 OpenCode 原生 Harness 系统提示词，tools 对齐 2.2.7 的 12 个原生工具，
 *      description 使用原生中性文案，上游永远流式（stream:true）；
 *   6. 默认匿名密钥 "public"——若开启复用本机 auth.json 则优先读取真实登录态。
 */
import { randomBytes } from 'node:crypto';

/** 我们冒充的 OpenCode 版本。zen 停收这个主版本时只需改这一处。 */
export const OPENCODE_VERSION = '2.2.7';

/** 与 OpenCode Desktop 一致的客户端标识 */
export const OPENCODE_CLIENT = 'desktop';

/** OpenCode 2.2.7 Desktop 实测发出的 User-Agent。 */
export const OPENCODE_USER_AGENT = `opencode/latest/${OPENCODE_VERSION}/${OPENCODE_CLIENT}`;

/** 没登录时 OpenCode 用的匿名密钥；zen 的免费模型认它。 */
export const OPENCODE_ANONYMOUS_KEY = 'public';

/** 免费池真正伺候的根：zen 的 /zen 前缀会被拒，要打 /inference。 */
export const ZEN_INFERENCE_ROOT = 'https://opencode.ai/inference';

/** 模型目录的备用源（免费判定/上下文窗口/每模型协议标注都靠它）。 */
export const MODELS_DEV_URL = 'https://models.dev/api.json';

/** 与 OpenCode v2.2.7 原生 messages[0] 头部对齐的静态 Harness 系统提示词 */
export const OPENCODE_HARNESS_SYSTEM = [
  'You are an AI agent running in OpenCode, a coding agent harness. Help the user accomplish their goals using the tools you have available.',
  '',
  '# Harness',
  '- Responses are rendered as GitHub-flavored Markdown.',
  '- `<system-reminder>` blocks are harness instructions, not user-authored content. Read and follow them.',
  '- Prefer parallelizing independent tool calls.',
  '- Prefer dedicated tools over shell commands; fall back to the shell when a tool cannot do what you need.',
  '- Do not chain shell commands with separators like `echo "====";` or `printf \'---\'`; the output becomes noisy in a way that makes the user\'s side of the conversation worse.',
  '- Use the write tool to create files or completely replace their content. Prefer using the edit tool for targeted changes.',
  '- Use the edit tool for targeted changes to existing text files. It replaces the exact text in `oldString` with `newString`, and the values must differ. By default, `oldString` must occur exactly once. If it occurs multiple times, include more surrounding context to make it unique or set `replaceAll` to true to replace every occurrence.',
  '',
  '# Communication',
  '- Use clear file paths when referring to files.',
  '- Keep responses clear and concise, and avoid unnecessary technical jargon.',
  '',
  '# Working in codebases',
  '- Keep changes consistent with the structure, naming, style, and patterns of the surrounding code.',
  '- Treat unfamiliar files or changes as potential user work and investigate before deleting or overwriting them.',
].join('\n');

/**
 * 与 OpenCode v2.2.7 Desktop 完全一致的 12 个原生工具列表与顺序。
 * 全部采用原生中性描述（严禁出现 "Never call this tool" 等非原生签名），
 * 模型若真调工具，调用会以结构化 tool_call 回到响应里，交由 handoff 转交或纠正回信封。
 */
export const OPENCODE_CORE_TOOLS = Object.freeze([
  'edit',
  'glob',
  'grep',
  'question',
  'read',
  'shell',
  'skill',
  'subagent',
  'webfetch',
  'websearch',
  'write',
  'execute',
]);

export const OPENCODE_TOOL_DESCRIPTIONS = Object.freeze({
  edit:
    'Edit the contents of a file by finding and replacing exact text. When editing text from Read output, preserve the exact indentation (tabs or spaces) and omit the line-number prefix, such as `1: `. Never include the prefix in oldString or newString. Write line breaks as \\n; the file\'s existing CRLF or LF line endings are matched and preserved. To change line endings themselves, make oldString and newString differ only in \\r; that edit applies to the exact bytes. If there is no exact match, the edit retries while ignoring typographic quote, dash, and space variants, then trailing whitespace on each line. The edit fails if oldString is not found. By default, oldString must identify a UNIQUE location. Multiple matches FAIL unless replaceAll is true. Add more surrounding context to disambiguate, or set replaceAll to true to replace every occurrence. Use replaceAll when the change should apply to every occurrence, such as renaming a variable.',
  glob: 'Search file paths using a glob pattern (examples: "**/*.ts", "src/**/*.tsx").',
  grep:
    'Search file contents using ripgrep\'s regular expression syntax or literal text matching. Use it to locate specific code, symbols, or text patterns, and narrow searches with `path` or `include`. Returns matching file paths, line numbers, and line previews.',
  question:
    'Use this tool when you need to ask the user questions during execution. This allows you to:\n1. Gather user preferences or requirements\n2. Clarify ambiguous instructions\n3. Get decisions on implementation choices as you work\n4. Offer choices to the user about what direction to take.\n\nUsage notes:\n- A "Type your own answer" option is added automatically; don\'t include a separate option for free form answers\n- Set `multiple: true` to allow selecting more than one option\n- If you recommend a specific option, make that the first option in the list and add "(Recommended)" at the end of the label',
  read:
    'Read the contents of a file or directory. Supports text files, images, and PDFs. Images and PDFs are presented directly to the model. Each text line is prefixed by its 1-based line number as <line>: <content>. The prefix is for reference and is not part of the file content. Directory entries are returned one per line. Use offset and limit to read large files or directories in sections. Prefer one larger read over many small slices, and use grep to find specific content in large files.',
  shell:
    'Execute a shell command and return its output. Commands run on macOS using zsh. Quote file paths containing spaces or special characters. Prefer dedicated tools over shell commands when possible. When output is large, the full result is saved to a file and a truncated preview is returned. Rely on automatic truncation unless filtering the output is more useful. Commands accept an optional timeout, background commands have no timeout by default. Background commands return immediately, and you will be notified when they complete.',
  skill:
    'Load a specialized skill\'s instructions and resources into the current conversation when the task at hand matches its description.\n\nThe skill ID must match an available skill or a skill explicitly referenced by the user.',
  subagent:
    'Spawns an agent in a child session to work on the specified task.\nThe output includes a sessionID you can pass back later to continue that specific conversation with the subagent.\nNew child sessions start with fresh context, so include all relevant context and instructions when you don\'t pass a sessionID.\nForeground (default) runs the subagent to completion and returns its final response.\nBackground mode (background=true) launches it asynchronously and returns immediately; you are notified when it finishes.\nUse background only for independent work that can run while you continue elsewhere.\n\nAvailable subagents:\n- explore: Fast agent specialized for exploring codebases. Use this when you need to quickly find files by patterns (eg. "src/components/**/*.tsx"), search code for keywords (eg. "API endpoints"), or answer questions about the codebase (eg. "how do API endpoints work?"). When calling this agent, specify the desired thoroughness level: "quick" for basic searches, "medium" for moderate exploration, or "very thorough" for comprehensive analysis across multiple locations and naming conventions.\n- general: General-purpose agent for researching complex questions and executing multi-step tasks. Use this agent to execute multiple units of work in parallel.',
  webfetch:
    'Fetch content from an HTTP or HTTPS URL and return it as text, markdown, or HTML. Markdown is the default.\n\nUse a more targeted tool when one is available. This tool is read-only. Large text results may be replaced with a preview while the complete output is retained in managed storage.',
  websearch:
    'Search the web using the user\'s selected search integration. Use this for current information beyond knowledge cutoff.\n\nThe current year is 2026. Use this year when searching for recent information or current events.',
  write:
    'Writes a file to the local filesystem, overwriting if one exists.\n\nMissing parent directories are created automatically.\n\nUse this tool to create new files or overwrite existing files. For partial changes, use the edit tool instead.',
  execute:
    'Run JavaScript in a confined Code Mode runtime to script tool calls and HTTP requests and compose their results.\n`fetch` is available for HTTP requests. Imports, direct filesystem access, and timers are unavailable: there is no `setTimeout` or sleep. All other external access goes through `tools`.\nWithin `{ code }`, the only callable tools are those explicitly listed in the Code Mode catalog instructions or returned by the `search` function. Inside `{ code }`, ignore tools shown outside the Code Mode catalog. They are not available in the Code Mode runtime.\nCall tools through `tools` using only exact paths and signatures from the catalog. Do not infer or normalize tool names; preserve bracket notation such as `tools.<namespace>["tool-name"](input)`.\nPrefer an explicit `return`; if omitted, the final top-level expression becomes the result.\nAwait every call whose completion matters; pending calls are interrupted when execution ends. Run independent calls concurrently with `Promise.allSettled`.',
});

export const OPENCODE_TOOL_SCHEMAS = Object.freeze({
  edit: Object.freeze({
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File to edit' },
      oldString: { type: 'string', description: 'Exact text to find and replace' },
      newString: { type: 'string', description: 'Text to replace oldString with (must differ from oldString)' },
      replaceAll: {
        type: 'boolean',
        description: 'Whether to replace every occurrence of oldString. When false, oldString must match exactly once. Defaults to false.',
      },
    },
    required: ['path', 'oldString', 'newString'],
    additionalProperties: false,
  }),
  glob: Object.freeze({
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern to match files against' },
      path: { type: 'string', description: 'Directory to search. Defaults to the current working directory.' },
      hidden: { type: 'boolean', description: 'Include hidden files and directories (default: false).' },
      limit: { type: 'integer', exclusiveMinimum: 0, description: 'Maximum number of matching files to return (default: 100)' },
    },
    required: ['pattern'],
    additionalProperties: false,
  }),
  grep: Object.freeze({
    type: 'object',
    properties: {
      pattern: { type: 'string', minLength: 1, description: 'Regular expression or literal text to match in file contents.' },
      path: { type: 'string', description: 'File or directory to search. Defaults to the current working directory.' },
      include: { type: 'string', description: 'Glob pattern to filter files (for example, "*.js" or "*.{ts,tsx}")' },
      literal: { type: 'boolean', description: 'Treat `pattern` as exact text instead of a regular expression (default: false).' },
      caseSensitive: { type: 'boolean', description: 'Use case-sensitive matching (default: true).' },
      limit: { type: 'integer', exclusiveMinimum: 0, description: 'Maximum number of matching lines to return (default: 100)' },
    },
    required: ['pattern'],
    additionalProperties: false,
  }),
  question: Object.freeze({
    type: 'object',
    properties: {
      questions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            question: { type: 'string', description: 'Complete question' },
            header: { type: 'string', description: 'Very short label (max 30 chars)' },
            options: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  label: { type: 'string', description: 'Display text (1-5 words, concise)' },
                  description: { type: 'string', description: 'Explanation of choice' },
                },
                required: ['label', 'description'],
                additionalProperties: false,
              },
              description: 'Available choices',
            },
            multiple: { type: 'boolean' },
          },
          required: ['question', 'header', 'options'],
          additionalProperties: false,
        },
        minItems: 1,
        description: 'Questions to ask',
      },
    },
    required: ['questions'],
    additionalProperties: false,
  }),
  read: Object.freeze({
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File or directory to read' },
      offset: { type: 'integer', description: 'The line or directory entry to start reading from (1-based)' },
      limit: { type: 'integer', minimum: 0, description: 'The maximum number of lines or directory entries to read (defaults to and capped at 2000)' },
    },
    required: ['path'],
    additionalProperties: false,
  }),
  shell: Object.freeze({
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Shell command string to execute' },
      workdir: { type: 'string', description: 'Working directory to execute the command in. Defaults to the current working directory. When possible, avoid changing directories in the command and set the working directory here instead.' },
      timeout: { type: 'integer', minimum: 0, description: 'Timeout in milliseconds. Set to 0 to disable the timeout. Defaults to 120000 for foreground commands. Background commands have no timeout by default.' },
      background: { type: 'boolean', description: 'Run the command in the background and return immediately (useful for dev servers and long-running builds). You do not need to use \'&\' at the end of the command when using this parameter. You will be notified when it completes. DO NOT poll for completion.' },
    },
    required: ['command'],
    additionalProperties: false,
  }),
  skill: Object.freeze({
    type: 'object',
    properties: {
      id: { type: 'string', description: 'The ID of an available skill or a skill explicitly referenced by the user' },
    },
    required: ['id'],
    additionalProperties: false,
  }),
  subagent: Object.freeze({
    type: 'object',
    properties: {
      agent: { type: 'string', description: 'The type of specialized agent to use for this task. If the user asks for a subagent by a name that is not one of the available subagents, they most likely mean a model: pick a suitable agent and pass the name through the model parameter instead.' },
      description: { type: 'string', description: 'A short 3-5 word label for the task, displayed to the user' },
      prompt: { type: 'string', description: 'The task for the subagent to perform' },
      model: { type: 'string', description: 'NEVER set this unless the user explicitly asks for a particular model or variant. It must be a chat model; image and decision models can\'t run subagents. The value is written as "providerID/modelID", or "providerID/modelID#variant" to include a variant. Do not guess the ID: look the model up with the models tool, filtering to your own provider first.' },
      sessionID: { type: 'string', pattern: '^ses', description: 'Send a follow-up to an existing subagent, running or finished. Omit to start a new one.' },
      background: { type: 'boolean', description: 'Run the subagent in the background and return immediately. You will be notified when it completes. DO NOT sleep, poll, or proactively check on its progress.' },
    },
    required: ['agent', 'description', 'prompt'],
    additionalProperties: false,
  }),
  webfetch: Object.freeze({
    type: 'object',
    properties: {
      url: { type: 'string', description: 'The HTTP or HTTPS URL to fetch content from' },
      format: { type: 'string', enum: ['text', 'markdown', 'html'], description: 'The format to return the content in. Defaults to markdown.' },
      timeout: { type: 'number', exclusiveMinimum: 0, maximum: 120, description: 'Optional timeout in seconds (maximum: 120)' },
    },
    required: ['url'],
    additionalProperties: false,
  }),
  websearch: Object.freeze({
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Websearch query' },
    },
    required: ['query'],
    additionalProperties: false,
  }),
  write: Object.freeze({
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the file to write to' },
      content: { type: 'string', description: 'Content to write to the file' },
    },
    required: ['path', 'content'],
    additionalProperties: false,
  }),
  execute: Object.freeze({
    type: 'object',
    properties: {
      code: { type: 'string' },
    },
    required: ['code'],
    additionalProperties: false,
  }),
});

/** OpenCode 版式 id 的形状（前缀 3 个小写字母 + 12 位十六进制 + 14 位 base62）。 */
export const OPENCODE_ID_PATTERN = /^[a-z]{3}_[0-9a-f]{12}[0-9A-Za-z]{14}$/;

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/**
 * id 生成的时钟与计数器（OpenCode 的 identifier.ts 同款逻辑）：
 * 同一毫秒内多次生成时用低位计数器区分。会话 id（descending）把时间位取反，
 * 让"最新的会话"在字典序里排最前——zen 还会校验这 12 位的低位计数必须很小，
 * 乱造一个同形状的哈希值会被 403。
 */
const idClock = {
  lastMs: 0,
  counter: 0,
};

/**
 * 造一个 OpenCode 版式的 id。
 * @param {string} prefix 三字母前缀（'ses' 会话 / 'msg' 回合）
 * @param {object} [o]
 * @param {boolean} [o.descending] true = 时间位按位取反（会话 id 用）
 * @param {number} [o.now] 时间戳（默认现在；测试注入用）
 * @returns {string} 形如 `ses_012345abcdefABcdEFghijKL`
 */
export function openCodeNewID(prefix, { descending = false, now = Date.now() } = {}) {
  const ms = Number.isFinite(now) ? Math.floor(now) : Date.now();
  if (ms !== idClock.lastMs) {
    idClock.lastMs = ms;
    idClock.counter = 0;
  }
  idClock.counter += 1;
  let current = BigInt(ms) * 0x1000n + BigInt(idClock.counter);
  if (descending) current = ~current; // JS 的 ~ 对 BigInt 是按位取反
  // 和 Go 原版一样先掩到 48 位再格式化：取反后的值是负数，不先掩会格式出负号
  const hex = (current & 0xffffffffffffn).toString(16).padStart(12, '0');
  const random = randomBytes(14);
  let id = `${prefix}_${hex}`;
  for (const byte of random) id += BASE62[byte % BASE62.length];
  return id;
}

/** 这个 id 是不是 OpenCode 可能造出来的会话 id：形状对，且低 12 位的时间计数很小。 */
export function isOpenCodeSessionID(id) {
  if (typeof id !== 'string' || !id.startsWith('ses_') || !OPENCODE_ID_PATTERN.test(id)) return false;
  // Magpie 的校验口径：取第 14-16 位（十六进制）解析，取反后必须 < 16（计数器很小）
  const low = Number.parseInt(id.slice(13, 16), 16);
  return Number.isInteger(low) && 0xfff - low < 16;
}

/** 会话注册表：seed → ses_ id 的 LRU（同一会话复用、绝不跨会话共用）。 */
export function createSessionRegistry({ keep = 1000 } = {}) {
  const map = new Map(); // Map 本身按插入序，refresh 即 LRU
  return {
    /** 拿 seed 对应的会话 id；没有就造一个并记住（LRU 逐出最老的）。 */
    forSeed(seed) {
      const key = String(seed ?? '');
      if (isOpenCodeSessionID(key)) return key; // 调用方给的本来就是合法会话 id
      if (map.has(key)) {
        const id = map.get(key);
        map.delete(key);
        map.set(key, id); // 触一下，挪到最新
        return id;
      }
      const id = openCodeNewID('ses', { descending: true });
      map.set(key, id);
      if (map.size > keep) map.delete(map.keys().next().value);
      return id;
    },
    get size() {
      return map.size;
    },
  };
}

/**
 * 拼一次上游调用的伪装头。OpenAI 方言走 v2；Anthropic 旧接口保留 v1 门禁。
 *
 * @param {string} sessionID 已定的会话 id（ses_ 开头）
 * @param {{legacy?:boolean}} [o] legacy=true 时使用 v1 的 UA 与回合头
 * @returns {Record<string,string>}
 */
export function impersonationHeaders(sessionID, { legacy = false } = {}) {
  const headers = {
    'user-agent': legacy
      ? 'opencode/1.19.0 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14'
      : OPENCODE_USER_AGENT,
    'x-opencode-session': sessionID,
    'x-opencode-session-id': sessionID,
    'x-opencode-client': legacy ? 'cli' : OPENCODE_CLIENT,
    'x-opencode-project': 'global',
  };
  if (legacy) {
    headers['x-opencode-request'] = openCodeNewID('msg');
  } else {
    headers['x-session-affinity'] = sessionID;
    headers['x-session-id'] = sessionID;
  }
  return headers;
}

/**
 * 某个方言该带的认证头。匿名密钥 public：
 * chat/Responses 走 Bearer；Anthropic Messages 再加 x-api-key 和版本头
 * （OpenCode 用 @ai-sdk/anthropic，实测同款）。
 * @param {'chat'|'anthropic'|'responses'} dialect
 */
export function authHeaders(dialect) {
  const headers = { authorization: `Bearer ${OPENCODE_ANONYMOUS_KEY}` };
  if (dialect === 'anthropic') {
    headers['x-api-key'] = OPENCODE_ANONYMOUS_KEY;
    headers['anthropic-version'] = '2023-06-01';
  }
  return headers;
}

/** 各协议里 OpenCode v2.2.7 Desktop 的 12 个原生核心工具定义 */
export function stubTools(dialect) {
  return OPENCODE_CORE_TOOLS.map((name) => {
    const parameters = OPENCODE_TOOL_SCHEMAS[name];
    const description = OPENCODE_TOOL_DESCRIPTIONS[name];
    if (dialect === 'anthropic') {
      return { name, description, input_schema: parameters };
    }
    if (dialect === 'responses') {
      return { type: 'function', name, description, parameters };
    }
    return { type: 'function', function: { name, description, parameters } };
  });
}
