# Timesheets API

Fastify + TypeScript + Prisma backend for the Timesheets app.

## Local run setup

Create or update `.env` in the `timesheets-api` root with:

```dotenv
DATABASE_URL=<postgres-connection-string>
PORT=5000
CORS_ORIGIN=http://localhost:5173
TENANT_ID=<entra-tenant-id>
CLIENT_ID=<api-client-id>
```

Run locally with:

```bash
npm install
npm run dev
```

The API listens on `http://localhost:5000` by default.

## BambooHR leave sync setup

The API can sync approved BambooHR leave requests into `entry` rows.

### Required runtime settings

Set these app settings/environment variables:

- `BAMBOOHR_SYNC_ENABLED=true`
- `BAMBOOHR_SUBDOMAIN=<your-bamboo-subdomain>`
- `BAMBOOHR_API_KEY=<your-bamboo-api-key>`

Optional settings:

- `BAMBOOHR_LEAVE_PROJECT_ID=1`
- `BAMBOOHR_SYNC_LOOKBACK_DAYS=14`
- `BAMBOOHR_SYNC_LOOKAHEAD_DAYS=0`
- `BAMBOOHR_HOURS_PER_DAY=8`
- `BAMBOOHR_SYNC_INTERVAL_MINUTES=240`
- `BAMBOOHR_SYNC_RUN_ON_STARTUP=true`

## Azure secure secret configuration

For Azure hosting, keep secrets out of source control and out of plain app settings.

### Option A (recommended): App Service Key Vault references

Use App Service settings that directly reference Key Vault secrets, for example:

- `DATABASE_URL = @Microsoft.KeyVault(SecretUri=https://<vault>.vault.azure.net/secrets/DATABASE_URL/<version>)`
- `BAMBOOHR_API_KEY = @Microsoft.KeyVault(SecretUri=https://<vault>.vault.azure.net/secrets/BAMBOOHR_API_KEY/<version>)`
- `BAMBOOHR_SUBDOMAIN = @Microsoft.KeyVault(SecretUri=https://<vault>.vault.azure.net/secrets/BAMBOOHR_SUBDOMAIN/<version>)`

Then no code changes are needed at deploy time; the API reads them as normal env vars.

### Option B: Managed identity + runtime Key Vault fetch

This API also supports loading secrets from Key Vault at startup via managed identity.

Set:

- `AZURE_KEYVAULT_NAME=<vault-name>`

Optional secret-name overrides (defaults shown):

- `AZURE_KEYVAULT_SECRET_NAME` (default `DATABASE_URL`)
- `AZURE_KEYVAULT_SECRET_BAMBOOHR_API_KEY` (default `BAMBOOHR_API_KEY`)
- `AZURE_KEYVAULT_SECRET_BAMBOOHR_SUBDOMAIN` (default `BAMBOOHR_SUBDOMAIN`)

The server fetches each secret only if the target env var is not already set.

## Azure prerequisites

1. Enable **System-assigned managed identity** on the API app.
2. Grant that identity **Key Vault Secrets User** (RBAC) on the vault.
3. Add app settings above in Azure App Service Configuration.
4. Restart the app after configuration changes.

## Verify sync is running

On startup, the API starts the BambooHR scheduler when config is present.
Check application logs for:

- `BambooHR leave scheduler started`
- `BambooHR leave sync completed`