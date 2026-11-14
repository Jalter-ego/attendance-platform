# Certificado público de Supabase

`supabase-prod-ca-2021.crt` es la CA pública de Supabase, no una clave privada. Se descargó desde el servidor de distribución del proveedor:

https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt

SHA-256: `80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA`.

Para usarlo, desde `platform/platform_api`, configurar:

```dotenv
DB_SSL=true
DB_SSL_REJECT_UNAUTHORIZED=true
DB_SSL_CA_FILE=certs/supabase-prod-ca-2021.crt
```

La ruta relativa parte del directorio desde el que se inicia Node. Si el proveedor cambia su CA, descarga el nuevo certificado desde **Database Settings → SSL Configuration → Download Certificate** y actualiza la ruta. No obtengas la CA de una conexión sin verificar ni de una fuente ajena al proveedor.

Referencias: [SSL de Supabase](https://supabase.com/docs/guides/platform/ssl-enforcement), [SSL de node-postgres](https://node-postgres.com/features/ssl).
