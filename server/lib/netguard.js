// Outbound-request guard: blocks SSRF to loopback, private, link-local and
// metadata addresses for app callbacks and link unfurling. Resolution happens
// at validation time; `safeFetch` re-checks after redirects by refusing them.
import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';

function isPrivateIp(ip) {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 169 && b === 254) || a === 0;
  }
  if (isIP(ip) === 6) {
    const norm = ip.toLowerCase();
    return norm === '::1' || norm === '::' || norm.startsWith('fc') || norm.startsWith('fd')
      || norm.startsWith('fe80') || norm.endsWith(':127.0.0.1') || norm === '::ffff:127.0.0.1';
  }
  return true; // not an IP at all — shouldn't happen post-resolution
}

// Resolves a URL's host and returns null if it points at a private address.
// Also enforces http(s) and, optionally, https-only.
export async function assertPublicUrl(rawUrl, { httpsOnly = false } = {}) {
  let url;
  try { url = new URL(rawUrl); } catch { throw new Error('invalid_url'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('invalid_url_scheme');
  if (httpsOnly && url.protocol !== 'https:') throw new Error('https_required');

  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) {
    if (isPrivateIp(host)) throw new Error('private_address_blocked');
    return url;
  }
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal')) {
    throw new Error('private_address_blocked');
  }
  const records = await lookup(host, { all: true }).catch(() => {
    throw new Error('host_unresolvable');
  });
  if (!records.length || records.some(r => isPrivateIp(r.address))) {
    throw new Error('private_address_blocked');
  }
  return url;
}

// fetch() that refuses redirects (so a public URL can't 302 into a private
// one) and applies a timeout. `allowLocal` opts out for tests/dev.
export async function safeFetch(rawUrl, options = {}, { timeoutMs = 5000, allowLocal = false } = {}) {
  if (!allowLocal) await assertPublicUrl(rawUrl);
  return fetch(rawUrl, {
    redirect: 'manual',
    signal: AbortSignal.timeout(timeoutMs),
    ...options,
  });
}
