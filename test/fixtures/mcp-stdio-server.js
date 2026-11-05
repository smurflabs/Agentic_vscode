// A tiny MCP server over stdio for the tests: initialize, tools/list (two pages), tools/call (text, a picture, an error),
// resources and prompts, and requests of its own to the client (roots/list, elicitation) as real servers make them.
const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });
const send = m => process.stdout.write(JSON.stringify(m) + '\n');
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
let rootsAnswer = null;
const waiting = new Map();
process.stderr.write('fake server starting ' + (process.env.FAKE_TOKEN || 'no token') + '\n');
rl.on('line', line => {
  const m = JSON.parse(line);
  if (m.id === 'r1') { rootsAnswer = m.result; return; }
  if (typeof m.id === 'string' && waiting.has(m.id)) { waiting.get(m.id)(m.result); waiting.delete(m.id); return; }
  switch (m.method) {
    case 'initialize':
      send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: { listChanged: true }, resources: {}, prompts: {} }, serverInfo: { name: 'fake', version: '1' }, instructions: 'Use echo for tests.' } });
      break;
    case 'notifications/initialized':
      send({ jsonrpc: '2.0', id: 'r1', method: 'roots/list', params: {} });
      break;
    case 'tools/list':
      if (!m.params || !m.params.cursor) send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'echo', description: 'Echoes', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }], nextCursor: 'p2' } });
      else send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'shot', description: 'A picture' }, { name: 'roots', description: 'What roots/list said' }, { name: 'env', description: 'FAKE_TOKEN' }, { name: 'ask', description: 'Asks the user' }] } });
      break;
    case 'resources/list':
      send({ jsonrpc: '2.0', id: m.id, result: { resources: [{ uri: 'memo://one', name: 'One', mimeType: 'text/plain' }] } });
      break;
    case 'resources/templates/list':
      send({ jsonrpc: '2.0', id: m.id, result: { resourceTemplates: [] } });
      break;
    case 'resources/read':
      send({ jsonrpc: '2.0', id: m.id, result: { contents: [{ uri: m.params.uri, mimeType: 'text/plain', text: 'content of ' + m.params.uri }] } });
      break;
    case 'prompts/list':
      send({ jsonrpc: '2.0', id: m.id, result: { prompts: [{ name: 'review', description: 'Review a file', arguments: [{ name: 'file', required: true }, { name: 'focus' }] }] } });
      break;
    case 'prompts/get':
      send({ jsonrpc: '2.0', id: m.id, result: { messages: [{ role: 'user', content: { type: 'text', text: `Review ${m.params.arguments.file} for ${m.params.arguments.focus || 'everything'}` } }] } });
      break;
    case 'tools/call': {
      const a = m.params.arguments || {};
      if (m.params.name === 'echo') send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'echo: ' + a.text }] } });
      else if (m.params.name === 'shot') send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'here' }, { type: 'image', mimeType: 'image/png', data: PNG }] } });
      else if (m.params.name === 'roots') send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: JSON.stringify(rootsAnswer) }] } });
      else if (m.params.name === 'env') send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: String(process.env.FAKE_TOKEN) + '|' + process.argv.slice(2).join('|') }] } });
      else if (m.params.name === 'ask') {
        const askId = 'e' + m.id;
        waiting.set(askId, r => send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'answer: ' + JSON.stringify(r) }] } }));
        send({ jsonrpc: '2.0', id: askId, method: 'elicitation/create', params: { message: 'Which branch?', requestedSchema: { type: 'object', properties: { branch: { type: 'string' } } } } });
      }
      else send({ jsonrpc: '2.0', id: m.id, result: { isError: true, content: [{ type: 'text', text: 'no such tool' }] } });
      break;
    }
    default:
      if (m.id !== undefined) send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'unknown' } });
  }
});
