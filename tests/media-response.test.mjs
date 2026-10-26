import assert from 'node:assert/strict';
import test from 'node:test';
import { mediaResponse } from './_media-response.mjs';

function response(range, method = 'GET') {
  const headers = {};
  const res = { setHeader: (name, value) => { headers[name] = value; }, end(body) { this.body = body; } };
  mediaResponse({ headers: { range }, method }, res, Buffer.from('0123456789'), 'video/mp4');
  return { ...res, headers };
}

test('video fixtures advertise ranges and return exact partial media with total size', () => {
  for (const [range, status, body, contentRange] of [
    [undefined, 200, '0123456789', undefined], ['bytes=2-5', 206, '2345', 'bytes 2-5/10'],
    ['bytes=6-', 206, '6789', 'bytes 6-9/10'], ['bytes=-3', 206, '789', 'bytes 7-9/10'],
    ['bytes=8-99', 206, '89', 'bytes 8-9/10'],
  ]) {
    const res = response(range);
    assert.equal(res.statusCode, status);
    assert.equal(res.body.toString(), body);
    assert.equal(res.headers['Content-Length'], body.length);
    assert.equal(res.headers['Content-Range'], contentRange);
    assert.equal(res.headers['Accept-Ranges'], 'bytes');
  }
});

test('invalid fixture ranges return 416 and HEAD returns metadata without a body', () => {
  for (const range of ['bytes=10-', 'bytes=8-2', 'bytes=-0', 'bytes=', 'bytes=1-2,4-5']) {
    const res = response(range);
    assert.equal(res.statusCode, 416);
    assert.equal(res.headers['Content-Range'], 'bytes */10');
    assert.equal(res.body, undefined);
  }
  const head = response('bytes=2-5', 'HEAD');
  assert.equal(head.statusCode, 206);
  assert.equal(head.headers['Content-Length'], 4);
  assert.equal(head.body, undefined);
});
