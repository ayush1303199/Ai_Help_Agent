import assert from 'node:assert/strict';
import { MeetingAgentTransport } from '../src/features/meeting/meetingTransport.ts';

const sockets = [];

class FakeWebSocket {
  static OPEN = 1;
  static holdNextOpen = false;
  readyState = 0;
  onopen = null;
  onmessage = null;
  onerror = null;
  onclose = null;
  sent = [];
  closed = false;

  constructor() {
    sockets.push(this);
    if (!FakeWebSocket.holdNextOpen) queueMicrotask(() => this.open());
    FakeWebSocket.holdNextOpen = false;
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  send(value) {
    this.sent.push(value);
  }

  close() {
    this.closed = true;
    this.readyState = 3;
    queueMicrotask(() => this.onclose?.());
  }
}

globalThis.WebSocket = FakeWebSocket;
globalThis.window = {
  setTimeout,
  clearTimeout,
};

const request = { mode: 'direct', messages: [{ role: 'user', content: 'Explain retry behavior.' }] };
const transport = new MeetingAgentTransport();
const preAbortedController = new AbortController();
preAbortedController.abort();
await assert.rejects(transport.send(request, preAbortedController.signal), (error) => error.name === 'AbortError');
assert.equal(sockets.length, 0, 'an already-cancelled request must not open a socket');

const abortController = new AbortController();
const pending = transport.send(request, abortController.signal);
await new Promise((resolve) => setImmediate(resolve));
assert.equal(sockets.length, 1);
assert.equal(sockets[0].sent.length, 1);
abortController.abort();
await assert.rejects(pending, (error) => error.name === 'AbortError');
await new Promise((resolve) => setImmediate(resolve));
assert.equal(sockets[0].closed, true, 'cancelling a Meeting answer closes its isolated socket and server task');

const reconnected = transport.send(request);
await new Promise((resolve) => setImmediate(resolve));
const completionSocket = sockets[1];
assert.equal(completionSocket.readyState, FakeWebSocket.OPEN, 'a new Meeting request reconnects after cancellation');
const requestId = JSON.parse(completionSocket.sent[0]).requestId;
completionSocket.onmessage?.({
  data: JSON.stringify({ type: 'done', requestId, content: 'Retry with bounded backoff.' }),
});
assert.deepEqual(await reconnected, { content: 'Retry with bounded backoff.', provider: undefined, model: undefined });
transport.close();

FakeWebSocket.holdNextOpen = true;
const connectingTransport = new MeetingAgentTransport();
const connectingAbort = new AbortController();
const connectingRequest = connectingTransport.send(request, connectingAbort.signal);
assert.equal(sockets.length, 3);
connectingAbort.abort();
await assert.rejects(connectingRequest, (error) => error.name === 'AbortError');
await new Promise((resolve) => setImmediate(resolve));
assert.equal(sockets[2].closed, true, 'cancellation while connecting closes the pending socket');

console.log('Meeting transport cancellation tests passed.');
