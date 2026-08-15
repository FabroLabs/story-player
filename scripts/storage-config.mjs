const BUCKET = 'story-player';

export function loadStorageConfig(env = process.env, { requireCredentials = true } = {}) {
  const endpoint = parseEndpoint(env.RUSTFS_URL);
  const bucket = required(env.STORY_PLAYER_BUCKET, 'STORY_PLAYER_BUCKET');
  if (bucket !== BUCKET) throw new Error(`STORY_PLAYER_BUCKET must be exactly ${BUCKET}`);

  const accessKeyId = optional(env.RUSTFS_ACCESS_KEY);
  const secretAccessKey = optional(env.RUSTFS_SECRET_KEY);
  if ((accessKeyId === null) !== (secretAccessKey === null)) {
    throw new Error('RUSTFS_ACCESS_KEY and RUSTFS_SECRET_KEY must be provided together');
  }
  if (requireCredentials && accessKeyId === null) {
    throw new Error('RUSTFS_ACCESS_KEY and RUSTFS_SECRET_KEY are required');
  }

  const rawRegion = env.RUSTFS_REGION;
  if (rawRegion !== undefined && String(rawRegion).trim() === '') {
    throw new Error('RUSTFS_REGION must not be blank');
  }
  const region = optional(rawRegion) ?? 'us-east-1';
  return Object.freeze({
    endpoint,
    publicBase: `${endpoint}/`,
    bucket,
    accessKeyId,
    secretAccessKey,
    region,
  });
}

export function publicObjectUrl(config, key) {
  requireObjectKey(key);
  return new URL(`${config.bucket}/${key}`, config.publicBase).href;
}

export function storageSummary(config) {
  return Object.freeze({
    endpoint: config.endpoint,
    bucket: config.bucket,
    region: config.region,
  });
}

function parseEndpoint(value) {
  const raw = required(value, 'RUSTFS_URL');
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('RUSTFS_URL must be an HTTP(S) origin');
  }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) {
    throw new Error('RUSTFS_URL must be an HTTP(S) origin');
  }
  if (url.username || url.password) throw new Error('RUSTFS_URL must not contain credentials');
  if (url.search || url.hash) throw new Error('RUSTFS_URL must not contain a query or fragment');
  if (url.pathname !== '/') throw new Error('RUSTFS_URL must not contain a path');
  return url.origin;
}

function requireObjectKey(key) {
  if (typeof key !== 'string' || !key || key.startsWith('/') || key.includes('\\')
      || key.includes('?') || key.includes('#')) {
    throw new Error('object key must be a safe relative S3 key');
  }
  let decoded;
  try {
    decoded = decodeURIComponent(key);
  } catch {
    throw new Error('object key must be a safe relative S3 key');
  }
  const segments = decoded.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error('object key must be a safe relative S3 key');
  }
}

function required(value, name) {
  const parsed = optional(value);
  if (parsed === null) throw new Error(`${name} is required`);
  return parsed;
}

function optional(value) {
  if (value === undefined || value === null) return null;
  const parsed = String(value).trim();
  return parsed || null;
}
