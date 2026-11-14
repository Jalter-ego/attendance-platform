// Error cuyo mensaje ya es comprensible y no contiene secretos: el worker lo muestra tal
// cual en la operación (RF-11). Cualquier otro error se reemplaza por un mensaje genérico.
export class OperationError extends Error {}
