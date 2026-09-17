import { completeProvider, normalizeProviderError, providerOrder } from './provider.js';
import { setConfiguredProviderStatus } from '../config.js';
import { isFallbackError } from './provider.js';

export const DEVELOPER_TOOLS = Object.freeze([
  {
    type: 'function',
    function: {
      name: 'list_directory',
      description: 'List files and directories in the selected project. Read-only.',
      parameters: { type: 'object', properties: { relativePath: { type: 'string', description: 'Relative directory path, or .' } }, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a text file in the selected project. Read-only.',
      parameters: { type: 'object', required: ['relativePath'], properties: { relativePath: { type: 'string' } }, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_code',
      description: 'Search file names and text in the selected project. Read-only.',
      parameters: { type: 'object', required: ['query'], properties: { query: { type: 'string' } }, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_symbols',
      description: 'Search indexed JavaScript/TypeScript symbols in the selected project. Read-only; returns bounded symbol locations only.',
      parameters: { type: 'object', required: ['query'], properties: { query: { type: 'string', maxLength: 200 } }, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_repository_map',
      description: 'Return a compact, repository-aware map of likely entry points, source directories, tests, config files, and boundaries. Read-only.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_references',
      description: 'Find symbol definitions and call sites for a specific symbol in the selected project. Read-only; results are bounded.',
      parameters: { type: 'object', required: ['query'], properties: { query: { type: 'string', maxLength: 200 } }, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_context',
      description: 'Assemble bounded ranked read-only project context from the selected project search results.',
      parameters: { type: 'object', required: ['query'], properties: { query: { type: 'string', maxLength: 200 }, maxTokens: { type: 'integer', minimum: 64, maximum: 12000 } }, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: 'Run one existing approved verification script from the selected project package.json. Never use this for arbitrary shell commands or file changes.',
      parameters: { type: 'object', required: ['script'], properties: { script: { type: 'string', enum: ['lint', 'typecheck', 'test', 'build', 'check', 'validate', 'verify'] } }, additionalProperties: false },
    },
  },
]);

const TOOL_NAMES = new Set(DEVELOPER_TOOLS.map((tool) => tool.function.name));

export function validateToolCall(call) {
  const name = call?.function?.name;
  if (!TOOL_NAMES.has(name)) throw new Error('Unsupported developer tool.');
  let args;
  try { args = JSON.parse(call.function.arguments || '{}'); } catch { throw new Error('Developer tool arguments must be valid JSON.'); }
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Developer tool arguments must be an object.');
  if (name === 'read_file' && typeof args.relativePath !== 'string') throw new Error('read_file requires a relative path.');
  if (name === 'search_code' && typeof args.query !== 'string') throw new Error('search_code requires a query.');
  if (name === 'search_symbols' && (typeof args.query !== 'string' || args.query.length > 200)) throw new Error('search_symbols requires a bounded query.');
  if (name === 'get_repository_map' && Object.keys(args).length > 0) throw new Error('get_repository_map accepts no arguments.');
  if (name === 'find_references' && (typeof args.query !== 'string' || args.query.length > 200)) throw new Error('find_references requires a bounded query.');
  if (name === 'get_context' && (typeof args.query !== 'string' || args.query.length > 200)) throw new Error('get_context requires a bounded query.');
  if (name === 'get_context' && args.maxTokens !== undefined && (!Number.isInteger(args.maxTokens) || args.maxTokens < 64 || args.maxTokens > 12000)) throw new Error('get_context maxTokens is out of range.');
  if (name === 'run_command' && typeof args.script !== 'string') throw new Error('run_command requires a script name.');
  if (name === 'list_directory' && args.relativePath !== undefined && typeof args.relativePath !== 'string') throw new Error('list_directory relativePath must be a string.');
  return { name, args };
}

export async function completeDeveloper({ messages, allowTools = true }) {
  let lastError;
  for (const provider of providerOrder({ requireToolCalling: true, allowPreviouslyFailed: true })) {
    try {
      const response = await completeProvider({ provider, messages, tools: allowTools ? DEVELOPER_TOOLS : undefined });
      if (provider.id) setConfiguredProviderStatus(provider.id, 'ok');
      return response.choices?.[0]?.message || {};
    } catch (error) {
      lastError = normalizeProviderError(error, provider.label || provider.adapterType || provider);
      if (provider.id) {
        const status = lastError.category === 'RATE_LIMIT'
          ? 'rate-limit'
          : lastError.category === 'CAPACITY_503'
            ? 'capacity-503'
            : lastError.category === 'TIMEOUT'
              ? 'timeout'
              : lastError.category === 'NETWORK_ERROR'
                ? 'network-error'
                : 'error';
        setConfiguredProviderStatus(provider.id, status, lastError.message);
      }
      if (/tools are not supported/i.test(lastError.message)) continue;
      if (!isFallbackError(lastError)) throw lastError;
    }
  }
  throw lastError || new Error('No configured provider available.');
}
