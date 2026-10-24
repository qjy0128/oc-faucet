/**
 * 转交（handoff）：把模型在隔离 OpenCode 里被拦下的本机动作，
 * 翻译成「外部客户端本次申报的工具」的一次调用提议。
 *
 * 背景：模型不听信封协议、直接调 OpenCode 自带工具（read/bash/…）时，
 * 审批闸门会把它拦下。光拒绝的话，模型下一轮还得把同一个动作用信封格式
 * 复述一遍——「复述」恰好是模型最容易做错的一步，还多花一整轮上游调用。
 * 转交直接把被拦的动作当答案交差：执行权照旧在外部客户端手里，
 * 我们返回的只是「提议」，和信封里的 calls 完全同权。
 *
 * 安全边界：**只填目标 schema 里存在的字段，必填项凑不齐就不转交**。
 * 映射表永远不可能放宽可执行范围——客户端没申报的工具一个都映射不到。
 */

/**
 * 原生工具 → 客户端工具的映射表。
 *
 * - native：OpenCode 自带工具名的小写写法（含历史别名）。
 * - targets：候选目标名，按优先级排；只映射到客户端本次请求实际申报了的那个。
 * - fields：原生参数名 → 目标参数名；一个原生名可能有多种目标写法
 *   （各家客户端的拼写并不统一），所以值可以是数组按序试。
 */
const CATEGORIES = [
  { native: ['bash', 'shell'], targets: ['Bash', 'PowerShell'],
    fields: { command: 'command', description: 'description', timeout: 'timeout' } },
  { native: ['read'], targets: ['Read'],
    fields: { filePath: 'file_path', file_path: 'file_path', path: 'file_path', offset: 'offset', limit: 'limit' } },
  { native: ['write'], targets: ['Write'],
    fields: { filePath: 'file_path', file_path: 'file_path', path: 'file_path', content: 'content' } },
  { native: ['edit', 'multiedit', 'multi_edit', 'patch', 'apply_patch'], targets: ['Edit', 'MultiEdit'],
    fields: { filePath: 'file_path', file_path: 'file_path', path: 'file_path',
      oldString: 'old_string', old_string: 'old_string', newString: 'new_string', new_string: 'new_string',
      replaceAll: 'replace_all', replace_all: 'replace_all', edits: 'edits' } },
  { native: ['glob'], targets: ['Glob', 'LS'],
    fields: { pattern: 'pattern', path: ['path', 'directory'], include: 'include' } },
  { native: ['grep'], targets: ['Grep', 'Search'],
    fields: { pattern: 'pattern', path: ['path', 'directory'], include: 'include', output_mode: 'output_mode' } },
  { native: ['skill'], targets: ['Skill'],
    fields: { name: ['name', 'skill'], skill: ['skill', 'name'], args: ['args', 'arguments'], arguments: ['arguments', 'args'] } },
];

/**
 * 把一个被拦下的本机动作翻译成客户端工具调用。
 *
 * @param {object} o
 * @param {string} o.native       OpenCode 原生工具名
 * @param {object} o.input        原生调用的参数（part 的 input + 审批 metadata 兜底后的合集）
 * @param {Array}  o.tools        客户端本次申报的工具（OpenAI 形状，protocol.js 归一后的）
 * @returns {{name:string, arguments:object}|null} 翻不出来就是 null，调用方退回纠正性拒批
 */
export function buildHandoff({ native, input = {}, tools = [] } = {}) {
  const name = String(native ?? '').toLowerCase();
  const category = CATEGORIES.find((entry) => entry.native.includes(name));
  if (!category) return null;
  for (const target of category.targets) {
    const spec = (Array.isArray(tools) ? tools : [])
      .map((tool) => tool?.function)
      .find((fn) => typeof fn?.name === 'string' && fn.name.toLowerCase() === target.toLowerCase());
    const properties = spec?.parameters?.properties;
    if (!properties) continue; // 这个候选目标客户端没申报（或没给 schema），换下一个
    const args = {};
    for (const [key, value] of Object.entries(input ?? {})) {
      const candidates = category.fields[key];
      if (!candidates || value === undefined) continue;
      for (const mapped of Array.isArray(candidates) ? candidates : [candidates]) {
        if (args[mapped] !== undefined || !Object.hasOwn(properties, mapped)) continue;
        args[mapped] = value;
        break;
      }
    }
    const required = Array.isArray(spec.parameters?.required) ? spec.parameters.required : [];
    if (!Object.keys(args).length) continue; // 一个字段都对不上，换下一个候选
    // 必填项缺一不转交：半截参数比没有参数更危险，宁可退回纠正性拒批
    if (!required.every((key) => args[key] !== undefined && args[key] !== null && args[key] !== '')) continue;
    return { name: spec.name, arguments: args };
  }
  return null;
}

/**
 * 拼出被拦动作的完整参数。
 *
 * 调用还在等审批时，OpenCode 把关键参数放在审批元数据里，工具 part 的 input
 * 要等执行才有值——所以有 part 以 part 为主，元数据只补它缺的那些字段。
 *
 * @param {{tool?:string, input?:object}|null} action     事件流里缓存的工具 part
 * @param {object|null} permission                        /permission 轮询到的审批载荷
 * @returns {object}
 */
export function handoffInput(action, permission) {
  const input = { ...(action?.input ?? {}) };
  const metadata = permission?.metadata ?? {};
  const fallback = {
    command: metadata.command,
    filePath: metadata.filepath ?? metadata.filePath ?? metadata.path,
    pattern: metadata.pattern ?? (Array.isArray(metadata.patterns) ? metadata.patterns[0] : undefined),
  };
  for (const [key, value] of Object.entries(fallback)) {
    if (input[key] === undefined && typeof value === 'string' && value.trim()) input[key] = value;
  }
  return input;
}

/**
 * 纠正性拒批的反馈文案。
 *
 * 拒绝必须点名工具和原因：含糊的拒绝会让模型继续瞎猜，
 * 而「反复尝试本地执行」正是含糊拒绝逼出来的行为。
 *
 * @param {string} native   被拦的原生工具名（拿不到就给个泛称）
 * @param {string} reason   没能转交的原因，说给人/模型听的一句话
 * @returns {string}
 */
export function rejectFeedback(native, reason) {
  const label = native || '本机工具';
  return `你调用的原生工具「${label}」被拦下了：${reason}。此环境不执行任何本机动作，` +
    '真正的执行权在外部客户端手里。请回到要求的 JSON 信封格式作答：' +
    '{"content":"给用户的文字，可为空串","calls":[{"name":"外部工具名","arguments":{}}]}，' +
    '把你想做的动作写进 calls 数组，外部客户端会执行并把结果带回来。不要再调用任何原生工具。';
}
