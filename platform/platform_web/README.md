# Frontend de Attendance Platform

React + TypeScript + Vite, utilizando el proyecto ya inicializado por el equipo.

```bash
pnpm install
pnpm dev
```

Abrir http://localhost:5173. El proxy `/api` apunta a la API de Node en `127.0.0.1:5001`. El backend, PostgreSQL y el worker se preparan siguiendo [las instrucciones de la plataforma](../README.md).

Las pantallas están organizadas por funcionalidad en `src/features/`; cada una contiene sus servicios, páginas, tipos y, cuando corresponde, hooks y contexto. `src/components/PlatformLayout.tsx` aporta el menú y layout común; las rutas se integran en `src/App.tsx`.

```bash
pnpm lint
pnpm build
```

El login utiliza una sesión con cookie HttpOnly y se recupera al recargar. El registro inicial todavía no aprovisiona AWS; el diagnóstico permite probar la cola y el progreso mientras P2 integra sus adaptadores.
