import { OperationError } from '../errors.js';
import { ENGINES, getAdapter } from '../../engines/adapter.js';

// Los adaptadores reales de P2 se construyen con la misma configuración en API y worker.
// Las pruebas pueden inyectar un registro distinto; no hay un simulador de producción.
export function createEngineAdapters(config) {
  if (!config) return {};
  return Object.fromEntries(Object.entries(ENGINES)
    .filter(([, engine]) => engine.available)
    .map(([engine]) => [engine, getAdapter(engine, config)]));
}

export function getEngineAdapter(engine, adapters = {}) {
  const adapter = Object.hasOwn(adapters, engine) ? adapters[engine] : null;
  if (!adapter || !['apply', 'outputs', 'versions'].every((method) => typeof adapter[method] === 'function'))
    throw new OperationError('ENGINE_NOT_AVAILABLE', 'El despliegue con este motor todavía no está disponible.');
  return adapter;
}

export function creationAvailability(engine, adapters = {}) {
  try {
    getEngineAdapter(engine, adapters);
    return { available: true, message: null };
  } catch (error) {
    return { available: false, message: error.message };
  }
}
