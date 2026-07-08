import './env.js';
import { createApp } from './app.js';
import { initDb } from './db/index.js';
import { startHealthChecker } from './services/health.js';

const PORT = process.env.PORT ?? 3001;
// Bind loopback by default (Q-325 hardening): this is a single-user LOCAL proxy;
// every legit consumer (responses-shim, economy-loop, substrate-*) already calls
// http://127.0.0.1:3001. Binding 0.0.0.0 exposed /api/keys mutation to the fleet
// overlays (AWG 10.0.0.2 + Tailscale). Override with HOST= only for a deliberate,
// authenticated public deployment (unsupported — see README).
const HOST = process.env.HOST ?? '127.0.0.1';

async function main() {
  initDb();
  const app = createApp();

  app.listen(Number(PORT), HOST, () => {
    console.log(`Server running on http://${HOST}:${PORT}`);
    console.log(`Proxy endpoint: http://${HOST}:${PORT}/v1/chat/completions`);
    startHealthChecker();
  });
}

main().catch(console.error);
