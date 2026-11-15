# Frontend de Attendance Platform

Panel de administración en React, TypeScript y Vite sobre el diseño verde del equipo. Incluye la portada, el acceso, el asistente de instituciones, respaldos, planes, operaciones, auditoría y monitoreo.

## Diseño de la portada

La portada pública (`/`) se compone en `src/features/landing/LandingPage.tsx`, con
estilos propios en `landing.css`. Conserva el verde de `--primary`; los colores de
texto, fondos y líneas de esta pantalla se definen en las variables `--landing-*`.
Los ejemplos de instituciones son ilustrativos y el acceso dirige al login o al
panel según la sesión existente.

La imagen de portada es un aula vacía sin personas, guardada como
`src/features/landing/empty-classroom.webp`. Su prompt y origen están en
`src/features/landing/empty-classroom.prompt.md`.

La tipografía base es **VTEX Trust**, copiada de Attendance y cargada desde
`src/assets/fonts/VTEXTrust` mediante `src/styles/fonts.css`. La familia se
configura con `--font-sans` en `src/index.css`.

## Diseño del acceso

El login (`/login`) tiene sus estilos en `src/features/auth/pages/login.css`.
Comparte el verde `--primary` y VTEX Trust con la portada. Sus colores de texto,
fondo y decoración se definen en las variables `--login-*`.

El formulario conserva las validaciones y la autenticación con cookie de sesión,
muestra los errores de acceso y permite mostrar u ocultar la contraseña.

## Diseño del panel principal

El menú y la cabecera del panel comparten los colores `--panel-*`, definidos en
`src/components/PlatformLayout.css`. El sidebar usa un verde profundo derivado de
`--primary`, con las variables `--sidebar-*` para sus textos y estados.
Conservan `--primary` y VTEX Trust; el fondo
incorpora formas de marca discretas y la navegación se adapta a pantallas pequeñas.

El directorio (`/tenants`) tiene estilos propios en
`src/features/tenants/pages/tenants.css`. Conserva los filtros en la URL, el catálogo
de planes, la paginación y la actualización automática cada cinco segundos.
El contador refleja los resultados de la consulta, incluidos los filtros activos.
Las acciones y secciones del menú siguen dependiendo del rol de la sesión.

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
