import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { rateLimit } from 'express-rate-limit';
import { errorHandler, HttpError } from './lib/errors.js';
import {
  login,
  requireSession,
  requireAdmin,
  tokenHash,
} from './modules/auth/auth.service.js';
import {
  listTenants,
  registerTenant,
  tenantDetail,
} from './modules/tenants/tenants.service.js';
import {
  enqueue,
  getOperation,
  operationLogs,
  cancelOperation,
  retryOperation,
} from './modules/operations/operations.service.js';
import { listBackups } from './modules/backups/backups.service.js';
import { ENGINES } from './engines/adapter.js';
import { BACKUP_BY_PLAN } from './engines/tenant-input.js';

export function createApp({ pool, config }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(express.json({ limit: '32kb' }));
  app.use(cookieParser());
  app.use((request, response, next) => {
    response.set('Cache-Control', 'no-store');
    const origin = request.get('origin');
    if (origin && origin !== config.CLIENT_ORIGIN)
      throw new HttpError(403, 'ORIGIN_NOT_ALLOWED', 'Origen no permitido.');
    if (origin) {
      response.set('Access-Control-Allow-Origin', config.CLIENT_ORIGIN);
      response.set('Access-Control-Allow-Credentials', 'true');
      response.vary('Origin');
    }
    if (request.method === 'OPTIONS') {
      response.set('Access-Control-Allow-Headers', 'Content-Type');
      response.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
      return response.sendStatus(204);
    }
    if (
      !['GET', 'HEAD', 'OPTIONS'].includes(request.method) &&
      !request.is('application/json')
    )
      throw new HttpError(
        415,
        'JSON_REQUIRED',
        'Envía Content-Type: application/json.',
      );
    next();
  });
  const api = express.Router();
  const cookie = {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.COOKIE_SECURE,
    path: '/api/v1',
  };
  api.get('/health', async (_request, response) => {
    try {
      await pool.query('SELECT 1');
      response.json({ status: 'ok', database: 'ok' });
    } catch {
      response
        .status(503)
        .json({ status: 'unavailable', database: 'unavailable' });
    }
  });
  api.post(
    '/auth/login',
    rateLimit({
      windowMs: 15 * 60000,
      limit: 20,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      message: {
        error: {
          code: 'TOO_MANY_ATTEMPTS',
          message: 'Demasiados intentos. Intenta de nuevo más tarde.',
        },
      },
    }),
    async (request, response) => {
      const session = await login(pool, config, request.body);
      response.cookie('platform_session', session.token, {
        ...cookie,
        expires: session.expiresAt,
      });
      response.json({ user: session.user, expires_at: session.expiresAt });
    },
  );
  api.use(requireSession(pool));
  api.get('/auth/me', (request, response) =>
    response.json({ user: request.user }),
  );
  api.post('/auth/logout', async (request, response) => {
    await pool.query('DELETE FROM sessions WHERE token_hash = $1', [
      tokenHash(request.cookies.platform_session),
    ]);
    response.clearCookie('platform_session', cookie).sendStatus(204);
  });
  api.get('/plans', async (_request, response) =>
    response.json({
      items: (
        await pool.query(
          "SELECT * FROM plans ORDER BY (sizing->>'db_disk_gb')::int",
        )
      ).rows.map((plan) => ({
        ...plan,
        // P2: respaldo que aplica el motor según el plan (variable "backup" del módulo).
        backup: BACKUP_BY_PLAN[plan.code] ?? null,
      })),
    }),
  );
  // P2: motores del selector del wizard y si ya tienen adaptador conectado al worker.
  api.get('/engines', (_request, response) =>
    response.json({
      items: Object.entries(ENGINES).map(([code, engine]) => ({ code, ...engine })),
    }),
  );
  api.get('/tenants', async (request, response) =>
    response.json(await listTenants(pool, request.user, request.query)),
  );
  api.post('/tenants', requireAdmin, async (request, response) =>
    response.status(201).json(await registerTenant(pool, request.body)),
  );
  api.get('/tenants/:id', async (request, response) =>
    response.json(await tenantDetail(pool, request.user, request.params.id)),
  );
  api.get('/tenants/:id/backups', async (request, response) =>
    response.json(
      await listBackups(pool, config, request.user, request.params.id),
    ),
  );
  api.post('/tenants/:id/operations', requireAdmin, async (request, response) =>
    response
      .status(202)
      .json(await enqueue(pool, request.user, request.params.id, request.body)),
  );
  api.get('/operations/:id', async (request, response) =>
    response.json(await getOperation(pool, request.user, request.params.id)),
  );
  api.get('/operations/:id/logs', async (request, response) =>
    response.json(
      await operationLogs(pool, request.user, request.params.id, request.query),
    ),
  );
  api.post('/operations/:id/cancel', requireAdmin, async (request, response) =>
    response.json(await cancelOperation(pool, request.user, request.params.id)),
  );
  api.post('/operations/:id/retry', requireAdmin, async (request, response) =>
    response
      .status(202)
      .json(await retryOperation(pool, request.user, request.params.id)),
  );
  app.use('/api/v1', api);
  app.use((_request, _response, next) =>
    next(new HttpError(404, 'NOT_FOUND', 'La ruta no existe.')),
  );
  app.use(errorHandler);
  return app;
}
