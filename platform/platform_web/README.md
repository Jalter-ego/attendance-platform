# Frontend de Attendance Platform

Panel de administración en React, TypeScript y Vite sobre el diseño verde del equipo. Incluye la portada, el acceso, el asistente de instituciones, respaldos, planes, operaciones, auditoría y monitoreo.

```bash
pnpm install --frozen-lockfile
pnpm dev
```

Abre [localhost:5173](http://localhost:5173). Vite reenvía `/api/v1` a `http://127.0.0.1:5001`. Si la API usa otro puerto, indica su origen en `PLATFORM_API_TARGET` en el `.env` de esta carpeta. Prepara Express, PostgreSQL y el worker con [las instrucciones de la plataforma](../README.md#arrancar-en-local).

Las pantallas están organizadas por funcionalidad en `src/features/`; cada una contiene sus servicios, páginas, tipos y, cuando corresponde, hooks y contexto. `src/components/PlatformLayout.tsx` aporta el menú y layout común; las rutas se integran en `src/App.tsx`.

```bash
pnpm lint
pnpm build
```

El login utiliza una cookie de sesión HttpOnly. El asistente puede registrar un borrador o encolar el aprovisionamiento en el mismo paso. El modo local usa recursos simulados. El ciclo de vida en modo integración admite Terraform y OpenTofu. Consulta el [manual de la demo](../README.local.md).
