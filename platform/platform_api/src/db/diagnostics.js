// No imprimir error.message: algunos drivers incluyen URLs, usuarios o SQL.
export function databaseErrorMessage(error) {
  const code = error?.code ?? error?.cause?.code;
  const messages = {
    SELF_SIGNED_CERT_IN_CHAIN:
      'Falta confiar en el certificado SSL. Para Supabase configura DB_SSL_CA_FILE=certs/supabase-prod-ca-2021.crt, con DB_SSL=true y DB_SSL_REJECT_UNAUTHORIZED=true.',
    DEPTH_ZERO_SELF_SIGNED_CERT:
      'El certificado SSL no tiene una autoridad de confianza. Revisa DB_SSL_CA_FILE.',
    UNABLE_TO_VERIFY_LEAF_SIGNATURE:
      'No se puede verificar la cadena SSL. Configura el certificado de confianza en DB_SSL_CA_FILE.',
    UNABLE_TO_GET_ISSUER_CERT_LOCALLY:
      'Falta el certificado de la autoridad SSL. Revisa DB_SSL_CA_FILE.',
    CERT_HAS_EXPIRED:
      'Un certificado de la cadena SSL ha vencido. Actualiza el certificado con tu proveedor.',
    ERR_TLS_CERT_ALTNAME_INVALID:
      'El certificado no corresponde al host. Copia nuevamente el host de la conexión de tu proveedor.',
    DB_CA_FILE_UNREADABLE:
      'No se pudo leer DB_SSL_CA_FILE. La ruta relativa parte de platform/platform_api al ejecutar los scripts desde esa carpeta.',
    DB_SSL_OPTIONS_CONFLICT:
      'La URL contiene sslmode/sslrootcert/sslcert/sslkey y sobrescribiría DB_SSL_CA_FILE. Quita esos parámetros de DATABASE_URL y configura SSL mediante DB_SSL_*.',
    '28P01':
      'PostgreSQL rechazó las credenciales. Revisa la contraseña de la base, el usuario del pooler y la codificación de caracteres especiales en DATABASE_URL.',
    28000:
      'PostgreSQL rechazó la autenticación. Revisa usuario, contraseña y permisos de conexión.',
    '3D000':
      'La base indicada en DATABASE_URL no existe. Copia el nombre de base de la conexión de tu proveedor.',
    '42P01':
      'Faltan tablas de la plataforma. Ejecuta pnpm db:migrate antes de iniciar la API o el worker.',
    '42P07':
      'Ya hay tablas que coinciden con la migración. Revisa que sea la base exclusiva de la plataforma; no borres tablas sin comprobar su origen.',
    42501:
      'El usuario de PostgreSQL no tiene permisos suficientes para esta operación.',
    ENOTFOUND:
      'No se encontró el host de DATABASE_URL. Revisa la URI copiada y la conexión DNS.',
    EAI_AGAIN:
      'No se pudo resolver el host. Revisa la conexión a Internet y DNS e intenta de nuevo.',
    ECONNREFUSED:
      'El servidor rechazó la conexión. Revisa host, puerto y que la base esté disponible.',
    ENETUNREACH:
      'La red del servidor no es accesible. Si tu conexión es IPv4, usa Session pooler de Supabase.',
    EHOSTUNREACH:
      'No se puede alcanzar el servidor. Revisa la red y las restricciones de acceso de la base.',
    ETIMEDOUT:
      'La conexión tardó demasiado. Revisa la red y las restricciones de acceso de la base.',
    ECONNRESET:
      'El servidor interrumpió la conexión. Revisa SSL, disponibilidad y restricciones de acceso.',
    ERR_INVALID_URL:
      'DATABASE_URL no es una URI válida. Copia la conexión completa y codifica los caracteres especiales de la contraseña.',
    EADDRINUSE:
      'El puerto de la API ya está ocupado. Detén el otro proceso o cambia PORT.',
  };
  if (messages[code]) return `[${code}] ${messages[code]}`;
  if (
    typeof error?.message === 'string' &&
    error.message.startsWith('Revisa estas variables:')
  )
    return error.message;
  if (error?.name === 'ZodError')
    return 'Revisa BOOTSTRAP_ADMIN_NAME, BOOTSTRAP_ADMIN_EMAIL y BOOTSTRAP_ADMIN_PASSWORD (12–128 caracteres).';
  return 'No se pudo completar la operación con PostgreSQL. Revisa la conexión, las migraciones y los permisos; no se imprimen datos privados del error.';
}
