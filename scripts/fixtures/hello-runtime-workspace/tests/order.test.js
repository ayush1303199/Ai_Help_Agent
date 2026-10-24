'use strict';

(async () => {
const a = (await import('node:assert/strict')).default, h = await import('node:http');
const [m, c, r, s] = await Promise.all([
  import("../models/Order.js"), import("../controllers/orderController.js"),
  import("../routes/orders.js"), import("../server.js"),
]);
const e = (x) => x.default && typeof x.default === 'object' ? x.default : x;
const model = e(m), controller = e(c), routes = e(r), app = e(s).createApplication();
const payload = {"customerName":"Sample customerName","Required":"Sample Required"};
const req = (method, url, body) => new Promise((ok, no) => {
  const text = body === undefined ? '' : JSON.stringify(body);
  const q = h.request({ host: '127.0.0.1', port: app.address().port, path: url, method,
    headers: text ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) } : {},
  }, (res) => { const chunks = []; res.on('data', (chunk) => chunks.push(chunk));
    res.on('end', () => ok({ status: res.statusCode, type: res.headers['content-type'] || '',
      text: Buffer.concat(chunks).toString('utf8') })); });
  q.once('error', no); if (text) q.write(text); q.end();
});
 a.equal(typeof model.validate, 'function');
 a.equal(typeof routes.registerRoutes, 'function');
await new Promise((ok, no) => { app.once('error', no); app.listen(0, '127.0.0.1', ok); });
try {
  a.equal((await req('GET', '/')).status, 200);
  const ui = await req('GET', "/orders");
  a.equal(ui.status, 200); a.match(ui.type, /^text\/html/i); a.match(ui.text, /<form\b/i);
  const made = await req("POST", "/api/orders", payload);
  a.equal(made.status, 201);
  const record = JSON.parse(made.text).data;
  
  
  const list = await req('GET', "/api/orders");
  a.equal(list.status, 200); a.ok(JSON.parse(list.text).data.some((item) => item.id === record.id));
  a.equal((await req("POST", "/api/orders", { ...payload, ["Required"]: '   ' })).status, 400);
  
  
  const failure = await controller["handleOrder"](Object.defineProperty({}, 'body', {
    get() { throw new Error('Simulated request read failure.'); },
  }));
  a.equal(failure.status, 500); a.equal(typeof failure.body?.error, 'string');
  console.log('PASS: loopback UI, API behavior, persistence, and controller error boundary.');
} finally {
  await new Promise((ok, no) => app.close((error) => error ? no(error) : ok()));
}
})().catch((error) => { console.error(error); process.exitCode = 1; });
