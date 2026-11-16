import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { rateLimit } from 'express-rate-limit';
import { errorHandler, HttpError } from './lib/errors.js';
import { requestLog } from './lib/request-log.js';
import {
  login,
  requireSession,
  requireAdmin,
  tokenHash,
} from './modules/auth/auth.service.js';
import { createTenantAdmin, listTenantAdmins, updateTenantAdmin } from './modules/auth/tenant-admins.service.js';
import { listAudit, recordAudit } from './modules/audit/audit.service.js';
import { transaction } from './db/pool.js';
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
  deletePreview,
  provisionTenant,
} from './modules/operations/operations.service.js';
import { listBackups } from './modules/backups/backups.service.js';
import { ENGINES } from './engines/adapter.js';
import { supportsRealLifecycle } from './engines/lifecycle-capabilities.js';
import { creationAvailability, createEngineAdapters } from './worker/engines/index.js';
import { createPlan, deletePlan, getPlan, listPlans, updatePlan } from './modules/plans/plans.service.js';
import { addScan, authorizeService, listAlerts, listScans, receiveAlerts } from './modules/observability.js';
import { z } from 'zod';
import { resolve } from 'node:path';

export function createApp({ pool, config, adapters = config.PLATFORM_DEPLOY_MODE === 'integration' ? createEngineAdapters(config) : {} }) {
  const app = express();
  app.disable('x-powered-by');
  if (config.LOG_REQUESTS ?? !process.env.NODE_TEST_CONTEXT) app.use(requestLog());
  app.use(helmet(config.PLATFORM_DEPLOY_MODE === 'local' ? {
    contentSecurityPolicy: { directives: { upgradeInsecureRequests: null } },
  } : {}));
  const api = express.Router();
  api.use(express.json({ limit: '32kb' }));
  api.use(cookieParser());
  api.use((request, response, next) => {
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
      response.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      response.set('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
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
      response.json({ user: session.user, expires_at: session.expiresAt, mode: config.PLATFORM_DEPLOY_MODE });
    },
  );
  api.post('/alerts/webhook', async (request, response) => {
    authorizeService(config, request.get('authorization'));
    response.status(201).json(await receiveAlerts(pool, request.body));
  });
  api.post('/tenants/:id/security', async (request, response) => {
    authorizeService(config, request.get('authorization'));
    response.status(201).json(await addScan(pool, request.params.id, request.body));
  });
  api.use(requireSession(pool));
  api.get('/auth/me', (request, response) =>
    response.json({ user: request.user, mode: config.PLATFORM_DEPLOY_MODE }),
  );
  api.post('/auth/logout', async (request, response) => {
    await pool.query('DELETE FROM sessions WHERE token_hash = $1', [
      tokenHash(request.cookies.platform_session),
    ]);
    response.clearCookie('platform_session', cookie).sendStatus(204);
  });
  api.get('/plans', async (request, response) => response.json(await listPlans(pool, request.user)));
  api.post('/plans', requireAdmin, async (request, response) =>
    response.status(201).json(await createPlan(pool, request.user, request.body)));
  api.get('/plans/:code', requireAdmin, async (request, response) =>
    response.json(await getPlan(pool, request.params.code)));
  api.put('/plans/:code', requireAdmin, async (request, response) =>
    response.json(await updatePlan(pool, request.user, request.params.code, request.body)));
  api.delete('/plans/:code', requireAdmin, async (request, response) => {
    await deletePlan(pool, request.params.code, request.user);
    response.sendStatus(204);
  });
  function engineCreation(engine) {
    if (config.PLATFORM_DEPLOY_MODE === 'local') return { available: true, message: null };
    if (!supportsRealLifecycle(engine, 'create'))
      return { available: false, message: 'El motor admite registro. Su aprovisionamiento real aún no está disponible.' };
    return creationAvailability(engine, adapters);
  }
  api.get('/engines', (_request, response) =>
    response.json({
      mode: config.PLATFORM_DEPLOY_MODE,
      items: Object.entries(ENGINES).map(([code, engine]) => ({
        code, ...engine, ...engineCreation(code),
        actions: ['create', 'suspend', 'resume', 'upgrade', 'plan-change', 'delete'].filter(
          (type) => config.PLATFORM_DEPLOY_MODE === 'local' || supportsRealLifecycle(code, type),
        ),
      })),
    }),
  );
  api.get('/tenants', async (request, response) =>
    response.json(await listTenants(pool, request.user, request.query)),
  );
  api.post('/tenants', requireAdmin, async (request, response) =>
    response.status(201).json(await transaction(pool, async (client) => {
      const tenant = await registerTenant(client, request.body);
      await recordAudit(client, request.user, { action: 'tenant-register', tenantId: tenant.id });
      return tenant;
    })),
  );
  api.post('/tenants/provision', requireAdmin, async (request, response) =>
    response.status(202).json(await provisionTenant(pool, config, request.user, request.body, { adapters })),
  );
  api.get('/tenants/:id', async (request, response) => {
    const tenant = await tenantDetail(pool, request.user, request.params.id);
    response.json({ ...tenant, creation: engineCreation(tenant.engine) });
  });
  api.get('/tenants/:id/admins', requireAdmin, async (request, response) =>
    response.json(await listTenantAdmins(pool, request.user, request.params.id)));
  api.post('/tenants/:id/admins', requireAdmin, async (request, response) =>
    response.status(201).json(await createTenantAdmin(pool, request.user, request.params.id, request.body)));
  api.patch('/tenants/:id/admins/:adminId', requireAdmin, async (request, response) =>
    response.json(await updateTenantAdmin(pool, request.user, request.params.id, request.params.adminId, request.body)));
  api.get('/tenants/:id/backups', async (request, response) =>
    response.json(
      await listBackups(pool, config, request.user, request.params.id),
    ),
  );
  api.get('/audit', requireAdmin, async (request, response) => response.json(await listAudit(pool, request.query)));
  api.get('/alerts', async (request, response) => response.json(await listAlerts(pool, request.user)));
  api.get('/tenants/:id/security', async (request, response) => response.json(await listScans(pool, request.user, request.params.id)));
  api.post('/tenants/:id/operations', requireAdmin, async (request, response) =>
    response
      .status(202)
      .json(await enqueue(pool, config, request.user, request.params.id, request.body, { adapters })),
  );
  function queueAction(type) {
    return async (request, response) => response.status(202).json(await enqueue(
      pool, config, request.user, request.params.id, { ...request.body, type }, { adapters },
    ));
  }
  for (const type of ['suspend', 'resume', 'upgrade', 'backup', 'restore', 'plan-change'])
    api.post(`/tenants/:id/${type}`, requireAdmin, queueAction(type));
  api.post('/tenants/:id/plan-change/preview', requireAdmin, queueAction('preview-plan'));
  api.post('/tenants/:id/delete-preview', requireAdmin, queueAction('preview-delete'));
  api.get('/tenants/:id/delete-preview', requireAdmin, async (request, response) =>
    response.json(await deletePreview(pool, request.user, request.params.id)));
  api.delete('/tenants/:id', requireAdmin, queueAction('delete'));
  api.post('/tenants/:id/retry', requireAdmin, async (request, response) => {
    const input = z.strictObject({ operation_id: z.uuid() }).parse(request.body);
    response.status(202).json(await retryOperation(pool, config, request.user, input.operation_id, request.params.id, { adapters }));
  });
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
      .json(await retryOperation(pool, config, request.user, request.params.id, null, { adapters })),
  );
  api.use((_request, _response, next) => next(new HttpError(404, 'NOT_FOUND', 'La ruta no existe.')));
  app.use('/api/v1', api);
  if (config.PLATFORM_WEB_DIST) {
    const root = resolve(config.PLATFORM_WEB_DIST);
    app.use(express.static(root));
    app.get(['/inicio', '/login', '/tenants', '/tenants/:id', '/backups', '/plans', '/monitoring', '/audit', '/demo/:id'],
      (_request, response) => response.sendFile('index.html', { root }));
  }
  app.use((_request, _response, next) =>
    next(new HttpError(404, 'NOT_FOUND', 'La ruta no existe.')),
  );
  app.use(errorHandler);
  return app;
}
