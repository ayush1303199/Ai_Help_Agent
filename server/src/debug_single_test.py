import sys
import os
sys.path.insert(0, os.path.abspath("server/src"))
import asyncio
import json
from pathlib import Path
from unittest.mock import patch
from types import SimpleNamespace
from coding_websocket import _run_coding_turn

provider = SimpleNamespace(type='groq', model='test-model')
responses = [
    ({'role': 'assistant', 'tool_calls': [{'id': 'search-1', 'type': 'function', 'function': {'name': 'search_code', 'arguments': '{"query":"slow SQL query"}'}}]}, provider),
    ({'role': 'assistant', 'tool_calls': [{'id': 'read-1', 'type': 'function', 'function': {'name': 'read_file', 'arguments': '{"relativePath":"src/data.py"}'}}]}, provider),
    ({'role': 'assistant', 'content': 'The query loop in src/data.py is the likely bottleneck.'}, provider),
]
payload = {'requestId': 'migration-contract', 'scope': 'src', 'messages': [{'role': 'user', 'content': 'Which query is slow?'}]}
state = {'pending': {}, 'completed': {}, 'tasks': set()}
events = []
tool_results = {
    'search-1': {'ok': True, 'data': {'results': [{'path': 'src/data.py'}]}},
    'read-1': {'ok': True, 'data': {'path': 'src/data.py', 'content': 'query = load_records()'}},
}
async def send_json(event):
    events.append(event)
    if event.get('type') == 'tool_call':
        key = f"{event['requestId']}:{event['toolCallId']}"
        state['completed'][key] = tool_results[event['toolCallId']]

with patch('coding_websocket.complete_coding_model', side_effect=responses):
    try:
        asyncio.run(_run_coding_turn(payload, send_json, state, None, Path('unused-config.json')))
    except Exception as e:
        print('EXCEPTION:', type(e), e)

print('EVENTS:', [e.get('type') for e in events])
for e in events:
    if e.get('type') in ('error', 'done'):
        print(e)
