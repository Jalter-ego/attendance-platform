// Interfaz común de los motores de aprovisionamiento (D1, P2). El worker solo habla con
// esta interfaz: no sabe si debajo corre terraform, tofu, pulumi o aws cloudformation.
import { OperationError } from '../worker/errors.js';
import { createTerraformAdapter } from './terraform.js';

/**
 * @typedef {object} EngineContext
 * @property {object} input   Entrada común del tenant (ver tenant-input.js).
 * @property {(message: string, options?: {stage?: string, progress?: number, level?: string}) => Promise<void>} report
 *           Registra un evento/etapa de la operación; lanza si se pidió cancelar.
 * @property {AbortSignal} signal  Apagado del worker o pérdida de la operación.
 * @property {string} logRef  Referencia a los eventos ("operations/<id>").
 *
 * @typedef {object} EngineResult  Salida común (docs/contratos-integracion.md).
 * @property {'succeeded'} status
 * @property {{type: string, role: string, id: string}[]} resources
 * @property {{urls: object, instance_ids: object, private_ips: object, [key: string]: any}} outputs
 * @property {Record<string, string|null>} tool_versions
 * @property {string} log_ref
 *
 * @typedef {object} EngineAdapter
 * @property {string} engine
 * @property {string} label
 * @property {(ctx: EngineContext) => Promise<Record<string, string|null>>} versions
 * @property {(ctx: EngineContext, options?: {destroy?: boolean}) => Promise<object|null>} preview
 *           Vista previa legible (crear/modificar/eliminar, pérdida de datos) sin aplicar.
 * @property {(ctx: EngineContext) => Promise<EngineResult>} apply    Crea o completa el stack (idempotente).
 * @property {(ctx: EngineContext) => Promise<EngineResult>} suspend  Detiene las EC2 conservando discos.
 * @property {(ctx: EngineContext) => Promise<EngineResult>} resume   Arranca las EC2; las URLs cambian.
 * @property {(ctx: EngineContext) => Promise<EngineResult>} destroy  Elimina el stack del tenant.
 * @property {(ctx: EngineContext) => Promise<object>} outputs        Outputs actuales del estado.
 */

export const ENGINES = {
  terraform: { label: 'Terraform', available: true },
  tofu: { label: 'OpenTofu', available: true },
  pulumi: { label: 'Pulumi', available: false },
  cloudformation: { label: 'CloudFormation', available: false },
};

export function engineAvailable(engine) {
  return Boolean(ENGINES[engine]?.available);
}

/** @returns {EngineAdapter} */
export function getAdapter(engine, config) {
  if (engine === 'terraform' || engine === 'tofu')
    return createTerraformAdapter(config, engine);
  throw new OperationError(
    'ENGINE_NOT_AVAILABLE',
    `El motor ${ENGINES[engine]?.label ?? engine} todavía no está conectado al worker.`,
  );
}

export { engineResult, resourcesFromOutputs } from './result.js';
