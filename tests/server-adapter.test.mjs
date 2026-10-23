import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { SuiAdapter } from '../server/proxy-adapter.mjs';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(`http://127.0.0.1:${server.address().port}`);
    });
  });
}

test('S-UI adapter rejects a real 307 redirect without forwarding its token even if init requests following', async (t) => {
  const token = 'synthetic-offline-redirect-test-token';
  let sourceRequests = 0;
  let destinationRequests = 0;
  let destinationToken;
  const destination = createServer((req, res) => {
    destinationRequests += 1;
    destinationToken = req.headers.token;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ success: true, obj: {} }));
  });
  t.after(() => new Promise((resolve) => destination.close(resolve)));
  const destinationUrl = await listen(destination);
  const source = createServer((req, res) => {
    sourceRequests += 1;
    assert.equal(req.headers.token, token);
    res.writeHead(307, { location: `${destinationUrl}/redirect-target` });
    res.end();
  });
  t.after(() => new Promise((resolve) => source.close(resolve)));
  const sourceUrl = await listen(source);
  const adapter = new SuiAdapter({ baseUrl: sourceUrl, token, vlessInboundId: 1 });
  await assert.rejects(adapter.request('/clients', { redirect: 'follow' }), /fetch failed|redirect/i);
  assert.equal(sourceRequests, 1);
  assert.equal(destinationRequests, 0, 'redirect target must not be contacted');
  assert.equal(destinationToken, undefined, 'redirect target must never receive the token');
});
