// Health checks después de aplicar: "Apply complete" confirma la infraestructura, no el
// final de cloud-init/Ansible. El tenant queda listo solo cuando frontend y backend
// responden 200 (contrato de P1/P4: outputs.urls.frontend_health y backend_health).
import { setTimeout as sleep } from 'node:timers/promises';
import { OperationError } from '../lib/operation-error.js';

async function probe(url, signal) {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(8000)].filter(Boolean)),
      redirect: 'manual',
    });
    return response.status;
  } catch {
    return null;
  }
}

/**
 * Espera a que todas las URLs respondan 200. `onWait(pending, elapsedS)` se llama cada
 * `reportEveryMs` para mostrar progreso (y permite cancelar desde `report`).
 */
export async function waitForHealth(
  urls,
  { timeoutMs, intervalMs = 10000, reportEveryMs = 30000, signal, onWait = () => {} },
) {
  const targets = Object.entries(urls).filter(([, url]) => url);
  if (!targets.length)
    throw new OperationError('El motor no devolvió URLs para comprobar la salud.');
  const started = Date.now();
  let lastReport = started;
  const status = {};
  for (;;) {
    signal?.throwIfAborted();
    await Promise.all(
      targets.map(async ([name, url]) => {
        if (status[name] !== 200) status[name] = await probe(url, signal);
      }),
    );
    const pending = targets.filter(([name]) => status[name] !== 200);
    if (!pending.length) return status;
    const elapsed = Date.now() - started;
    if (elapsed >= timeoutMs)
      throw new OperationError(
        `La infraestructura se creó, pero ${pending.map(([name]) => name).join(' y ')} no respondió en ${Math.round(timeoutMs / 1000)} s. Revisa /var/log/attendance-boot.log en la VM y reintenta (no duplica recursos).`,
      );
    if (Date.now() - lastReport >= reportEveryMs) {
      lastReport = Date.now();
      await onWait(
        pending.map(([name]) => `${name}: ${status[name] ?? 'sin respuesta'}`),
        Math.round(elapsed / 1000),
      );
    }
    await sleep(intervalMs, undefined, { signal });
  }
}
