# Frontend de Attendance Platform

Panel de administración en React, TypeScript y Vite sobre el diseño verde del equipo. Incluye la portada, el acceso, el asistente de instituciones, respaldos, planes, operaciones, auditoría y monitoreo.

## Diseño de la portada

La portada pública (`/`) se compone en `src/features/landing/LandingPage.tsx`, con
estilos propios en `landing.css`. Conserva el verde de `--primary`; los colores de
texto, fondos y líneas de esta pantalla se definen en las variables `--landing-*`.
Los ejemplos de instituciones son ilustrativos y el acceso dirige al login o al
panel según la sesión existente.

La tipografía base es **VTEX Trust**, copiada de Attendance y cargada desde
`src/assets/fonts/VTEXTrust` mediante `src/styles/fonts.css`. La familia se
configura con `--font-sans` en `src/index.css`.

## Desarrollo local

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
