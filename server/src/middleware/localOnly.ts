import type { Request, Response, NextFunction } from 'express';

// localOnly — key-management is an administrative, single-user LOCAL operation.
// The management dashboard is served from and reaches the API over loopback, so a
// socket-locality check does not break the UI, needs no token distribution, and
// closes the Q-325 hole: unauthenticated POST/DELETE /api/keys from a fleet peer
// (AWG 10.0.0.2 / Tailscale) could add an attacker key or delete ours. Defense in
// depth behind the 127.0.0.1 bind — it survives a future accidental 0.0.0.0 rebind.
// NOTE: trust-proxy is OFF (default), so req.ip is the real socket peer, not a
// spoofable X-Forwarded-For header.
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export function localOnly(req: Request, res: Response, next: NextFunction) {
  const ip = req.ip ?? req.socket.remoteAddress ?? '';
  if (LOOPBACK.has(ip)) {
    next();
    return;
  }
  res.status(401).json({
    error: { message: 'Key management is local-only', type: 'authentication_error' },
  });
}
