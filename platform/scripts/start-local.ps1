param(
    [ValidateSet('Start', 'Stop', 'Status')][string]$Action = 'Start',
    [switch]$SkipWorker,
    [ValidateRange(1, 4)][int]$WorkerCount = 1,
    [int]$PostgresPort = 5434,
    [string]$PostgresBin = 'C:\Program Files\PostgreSQL\17\bin'
)
$ErrorActionPreference = 'Stop'
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$local = Join-Path $repo '.local'
$data = Join-Path $local 'postgres'
$logs = Join-Path $local 'logs'
$api = Join-Path $repo 'platform/platform_api'
$envFile = Join-Path $api '.env'
$jqDirectory = Join-Path $repo '.local/tools/jq'
if (Test-Path (Join-Path $jqDirectory 'jq.exe')) { $env:PATH = "$jqDirectory;$env:PATH" }
$processFile = Join-Path $local 'processes.json'
New-Item -ItemType Directory -Force $local, $logs | Out-Null

function OwnedProcess($entry) {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$($entry.pid)" -ErrorAction SilentlyContinue
    if (!$process) { return $null }
    $started = (Get-Process -Id $entry.pid).StartTime.ToUniversalTime()
    $expectedStart = ([datetime]$entry.started).ToUniversalTime()
    if ($started.Ticks -ne $expectedStart.Ticks -or $process.CommandLine -ne $entry.commandLine) {
        throw "El PID $($entry.pid) pertenece a otro proceso; no se detuvo."
    }
    return $process
}
$entries = @()
if (Test-Path $processFile) { $entries = @(Get-Content $processFile -Raw | ConvertFrom-Json) }
if ($Action -eq 'Status') {
    foreach ($entry in $entries) {
        $running = $null -ne (OwnedProcess $entry)
        Write-Output "$($entry.name): running=$running pid=$($entry.pid)"
    }
    & (Join-Path $PostgresBin 'pg_ctl.exe') status -D $data
    exit
}
if ($Action -eq 'Stop') {
    foreach ($entry in $entries) {
        if (OwnedProcess $entry) { Stop-Process -Id $entry.pid }
    }
    if (Test-Path $processFile) { Remove-Item -LiteralPath $processFile }
    # pg_ctl verifies the postmaster PID against this exact dedicated data directory.
    if (Test-Path (Join-Path $data 'postmaster.pid')) {
        & (Join-Path $PostgresBin 'pg_ctl.exe') stop -D $data -m fast -w
        if ($LASTEXITCODE -ne 0) { throw 'No se pudo detener el cluster dedicado.' }
    }
    exit
}
foreach ($entry in $entries) {
    if (OwnedProcess $entry) { throw 'La plataforma ya está iniciada. Consulta -Action Status o usa -Action Stop.' }
}
$pgPasswordFile = Join-Path $local 'postgres.password'
if (!(Test-Path (Join-Path $data 'PG_VERSION'))) {
    if (Test-Path $data) { throw 'El directorio PostgreSQL ya existe sin PG_VERSION; revísalo antes de inicializar.' }
    $pgPassword = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(24)).ToLowerInvariant()
    [IO.File]::WriteAllText($pgPasswordFile, $pgPassword)
    & (Join-Path $PostgresBin 'initdb.exe') -D $data -U platform_local --pwfile=$pgPasswordFile --auth=scram-sha-256 --encoding=UTF8 --locale=C
    if ($LASTEXITCODE -ne 0) { throw 'Falló initdb.' }
    Add-Content (Join-Path $data 'postgresql.conf') "`nlisten_addresses = '127.0.0.1'`nport = $PostgresPort`n"
}
if (!(Test-Path (Join-Path $data 'postmaster.pid'))) {
    $pgLog = Join-Path $logs 'postgres.log'
    $pgStart = Start-Process -FilePath (Join-Path $PostgresBin 'pg_ctl.exe') -ArgumentList @('start','-D',('"' + $data + '"'),'-l',('"' + $pgLog + '"'),'-w') -WindowStyle Hidden -PassThru
    # Start-Process -Wait also waits for postgres descendants; wait only for pg_ctl.
    $pgStart.WaitForExit()
    if ($pgStart.ExitCode -ne 0) { throw 'Falló el inicio de PostgreSQL; revisa .local/logs/postgres.log.' }
}
if (!(Test-Path $envFile)) {
    $awsAccount = (& aws sts get-caller-identity --profile default --query Account --output text --no-cli-pager).Trim()
    if ($LASTEXITCODE -ne 0 -or $awsAccount -notmatch '^\d{12}$') {
        throw 'No se pudo verificar la cuenta AWS. Autentica el perfil antes de crear el entorno de integración.'
    }
    $stateBucket = "attendance-platform-tfstate-$awsAccount"
    $pgPassword = (Get-Content $pgPasswordFile -Raw).Trim()
    $adminPassword = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(18)).ToLowerInvariant()
    $pulumiPassword = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(24)).ToLowerInvariant()
    $tofu = (Get-Command tofu -ErrorAction Stop).Source.Replace('\','/')
    $rootForward = $repo.Replace('\','/')
    $env:PGPASSWORD = $pgPassword
    try {
        & (Join-Path $PostgresBin 'createdb.exe') -h 127.0.0.1 -p $PostgresPort -U platform_local attendance_platform_integration
        if ($LASTEXITCODE -ne 0) { throw 'No se pudo crear la base dedicada.' }
    } finally { Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue }
    @"
HOST=127.0.0.1
PORT=4100
NODE_ENV=development
CLIENT_ORIGIN=http://127.0.0.1:4100
DATABASE_URL=postgresql://platform_local:${pgPassword}@127.0.0.1:${PostgresPort}/attendance_platform_integration
DB_SSL=false
COOKIE_SECURE=false
PLATFORM_DEPLOY_MODE=integration
PLATFORM_WEB_DIST=$rootForward/platform/platform_web/dist
IAC_BASE_OUTPUTS=$rootForward/.local/base.outputs.json
IAC_AMI_IDS=$rootForward/infra/packer/ami-ids.json
IAC_RUNS_DIR=$rootForward/.local/runs
IAC_STATE_BUCKET=$stateBucket
PULUMI_CONFIG_PASSPHRASE=$pulumiPassword
PULUMI_BACKEND_URL=s3://$stateBucket/pulumi
AWS_PROFILE=default
AWS_REGION=us-east-2
AWS_DEFAULT_REGION=us-east-2
PLATFORM_STATE_REGION=us-east-2
TERRAFORM_BIN=$rootForward/.local/tools/terraform/terraform.exe
TOFU_BIN=$tofu
BACKUP_BASH=C:/Program Files/Git/bin/bash.exe
BOOTSTRAP_ADMIN_NAME=Administrador local
BOOTSTRAP_ADMIN_EMAIL=admin@platform.local
BOOTSTRAP_ADMIN_PASSWORD=$adminPassword
"@ | Set-Content -LiteralPath $envFile -Encoding utf8
    @"
Panel: http://127.0.0.1:4100
Modo: integration (las operaciones del panel crean/modifican recursos AWS reales).
Email: admin@platform.local
Password: $adminPassword
PostgreSQL: 127.0.0.1:$PostgresPort / attendance_platform_integration
Secretos: platform/platform_api/.env y .local/postgres.password
"@ | Set-Content (Join-Path $local 'demo-access.txt') -Encoding utf8
}
Push-Location $api
try {
    & pnpm db:migrate
    if ($LASTEXITCODE -ne 0) { throw 'Fallaron las migraciones.' }
    & pnpm admin:create
    if ($LASTEXITCODE -ne 0) { throw 'Falló el administrador inicial.' }
} finally { Pop-Location }
if (!(Test-Path (Join-Path $repo 'platform/platform_web/dist/index.html'))) {
    throw 'Compila el panel: pnpm --dir platform/platform_web build.'
}
if (Get-NetTCPConnection -State Listen -LocalPort 4100 -ErrorAction SilentlyContinue) {
    throw 'El puerto 4100 está ocupado; no se modificó su proceso.'
}
$node = (Get-Command node).Source
$entries = @()
try {
    $roles = @(@{ name = 'api'; script = 'src/server.js' })
    if (!$SkipWorker) {
        for ($index = 1; $index -le $WorkerCount; $index++) {
            $roles += @{ name = $(if ($index -eq 1) { 'worker' } else { "worker$index" }); script = 'src/worker/index.js' }
        }
    }
    foreach ($role in $roles) {
        $script = Join-Path $api $role.script
        $process = Start-Process -FilePath $node -WorkingDirectory $api -ArgumentList @('--env-file-if-exists=.env',('"' + $script + '"')) -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $logs "$($role.name).out.log") -RedirectStandardError (Join-Path $logs "$($role.name).err.log")
        $identity = Get-CimInstance Win32_Process -Filter "ProcessId=$($process.Id)"
        $entries += [pscustomobject]@{ name = $role.name; pid = $process.Id; started = $process.StartTime.ToUniversalTime().ToString('o'); commandLine = $identity.CommandLine }
        ConvertTo-Json -InputObject @($entries) | Set-Content $processFile -Encoding utf8
    }
    Start-Sleep -Seconds 2
    foreach ($entry in $entries) {
        if (!(OwnedProcess $entry)) { throw "$($entry.name) terminó. Revisa .local/logs." }
    }
    Write-Output 'Panel/API: http://127.0.0.1:4100. Credenciales: .local/demo-access.txt. Logs: .local/logs.'
} catch {
    foreach ($entry in $entries) { if (OwnedProcess $entry) { Stop-Process -Id $entry.pid } }
    throw
}
