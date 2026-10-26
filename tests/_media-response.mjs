// Seekable media for browser fixtures: full responses plus one HTTP byte range.
export function mediaResponse(req, res, bytes, type) {
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', type);
  const range = req.headers.range;
  let start = 0, end = bytes.length - 1;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    const suffix = match && !match[1] ? Number(match[2]) : null;
    start = match?.[1] ? Number(match[1]) : Math.max(0, bytes.length - suffix);
    end = match?.[1] && match[2] ? Math.min(Number(match[2]), end) : end;
    if (!match || (!match[1] && !(suffix > 0)) || !Number.isSafeInteger(start)
      || !Number.isSafeInteger(end) || start > end || start >= bytes.length) {
      res.statusCode = 416;
      res.setHeader('Content-Range', `bytes */${bytes.length}`);
      res.setHeader('Content-Length', 0);
      res.end();
      return;
    }
    res.statusCode = 206;
    res.setHeader('Content-Range', `bytes ${start}-${end}/${bytes.length}`);
  } else res.statusCode = 200;
  const body = bytes.subarray(start, end + 1);
  res.setHeader('Content-Length', body.length);
  res.end(req.method === 'HEAD' ? undefined : body);
}
