// Domain auto-join: workspaces can allow any user whose email is at one of
// their domains (e.g. @acme.com) to join automatically at register/login.
import { get, all, run, now } from '../db.js';
import { broadcastToWorkspace } from '../realtime.js';
import { publicUser } from '../auth.js';

function emailDomain(email) {
  const at = String(email || '').lastIndexOf('@');
  return at > 0 ? email.slice(at + 1).toLowerCase() : null;
}

// Joins the user to every workspace whose allowed_domains matches their email
// domain. Idempotent — safe to call at both register and login. Returns the
// workspaces newly joined.
export function applyDomainJoins(user) {
  const domain = emailDomain(user.email);
  if (!domain) return [];
  const workspaces = all(
    "SELECT * FROM workspaces WHERE allowed_domains != ''"
  ).filter(w => w.allowed_domains.toLowerCase().split(',').map(d => d.trim()).includes(domain));

  const joined = [];
  for (const ws of workspaces) {
    const result = run(
      'INSERT OR IGNORE INTO workspace_members (workspace_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)',
      ws.id, user.id, 'member', now()
    );
    if (result.changes === 0) continue;
    const general = get(
      'SELECT * FROM channels WHERE workspace_id = ? AND is_dm = 0 AND is_private = 0 ORDER BY id LIMIT 1',
      ws.id
    );
    if (general) {
      run('INSERT OR IGNORE INTO channel_members (channel_id, user_id, joined_at) VALUES (?, ?, ?)',
        general.id, user.id, now());
    }
    broadcastToWorkspace(ws.id, {
      type: 'workspace.member_joined',
      workspace_id: ws.id,
      user: publicUser(user),
    });
    joined.push(ws);
  }
  return joined;
}

const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

// Validates + normalizes a comma-separated domain list. Throws on bad input.
export function normalizeDomains(raw) {
  const domains = String(raw || '')
    .split(',')
    .map(d => d.trim().toLowerCase().replace(/^@/, ''))
    .filter(Boolean);
  for (const d of domains) {
    if (!DOMAIN_RE.test(d) || d.length > 253) throw new Error('invalid_domain');
  }
  return [...new Set(domains)].join(',');
}
