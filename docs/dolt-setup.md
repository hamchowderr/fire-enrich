# Dolt setup

Dolt is optional. It enables versioned run history and run-to-run diffs: each
enrichment run is recorded with its enrichments and evidence, ends in one Dolt
commit, and `GET /api/runs/:id/diff` compares it with the previous run of the
same list. Without Dolt, the app runs normally and does not record runs.

The app connects with the `DOLT_*` variables that `lib/dolt.ts` reads. Setting
`DOLT_HOST` and `DOLT_DATABASE` turns the feature on.

Every path below uses Dolt **2.3.1**, the same exact version as CI's `migrate`
job. Use that tag. Do not use `latest`.

- [Local development](#local-development)
- [Your own server (VPS)](#your-own-server-vps)
- [Managed alternative](#managed-alternative)

## Local development

### 1. Start Dolt

With Docker:

```sh
docker run -d --name fire-enrich-dolt -p 127.0.0.1:3306:3306 -v fire-enrich-dolt:/var/lib/dolt -e DOLT_ROOT_HOST=% -e DOLT_DATABASE=fire_enrich dolthub/dolt-sql-server:2.3.1
```

- The named volume `fire-enrich-dolt` keeps the data when the container is
  removed.
- `DOLT_ROOT_HOST=%` lets `root` log in from your machine. Without it, `root`
  can log in only from inside the container. The password stays empty, so the
  port is bound to `127.0.0.1` only.
- `DOLT_DATABASE` creates the `fire_enrich` database on first start.

Without Docker: install Dolt 2.3.1 from the
[release page](https://github.com/dolthub/dolt/releases/tag/v2.3.1), then run
this from an empty directory, which becomes the data directory:

```sh
dolt sql-server -H 127.0.0.1 -P 3306
```

It creates a `root` user with an empty password and serves no TLS. The
migration in step 3 creates the database.

### 2. Add the connection to `.env.local`

```sh
DOLT_HOST=127.0.0.1
DOLT_PORT=3306
DOLT_USER=root
DOLT_PASSWORD=
DOLT_DATABASE=fire_enrich
```

Use `127.0.0.1`, not `localhost`: on Windows, `localhost` can resolve to IPv6
first. Leave `DOLT_TLS_CA_B64` unset, because the local server has no TLS.

### 3. Apply the schema

```sh
node --env-file=.env.local scripts/db-migrate.mjs
```

This is `npm run db:migrate` with `.env.local` loaded. The script reads only
the process environment, so `npm run db:migrate` alone does not see
`.env.local`. Instead, you can export the five `DOLT_*` variables in your
shell and run `npm run db:migrate`.

The first run prints `5 tables changed` and a commit hash. A second run prints
`nothing changed — no commit`.

### 4. Run the app

```sh
npm run dev
```

Next loads `.env.local`, and each enrichment run is recorded in Dolt. To look
at the history:

```sh
docker exec fire-enrich-dolt dolt --use-db fire_enrich sql -q "SELECT id, status, commit_hash FROM enrichment_runs"
```

To remove everything: `docker rm -f fire-enrich-dolt` and
`docker volume rm fire-enrich-dolt`.

## Your own server (VPS)

`docker-compose.dolt.yml` runs Dolt 2.3.1 with TLS required, a named volume at
`/var/lib/dolt`, and an app user that can access only its own database. The
server needs Docker with the Compose plugin, and `openssl`.

Run every command below on the server, from a checkout of this repository (or
a copy of `docker-compose.dolt.yml` and `deploy/dolt/`).

### 1. Set the passwords

```sh
cp deploy/dolt/dolt.env.example deploy/dolt/dolt.env
openssl rand -hex 24   # use one output for DOLT_ROOT_PASSWORD
openssl rand -hex 24   # and another for DOLT_PASSWORD
```

Edit `deploy/dolt/dolt.env` and replace both `change-me` values. The image
puts the passwords into a quoted SQL string, so use only letters and digits
(hex output is safe).

On first start, while the volume is empty, the image creates:

- the database `DOLT_DATABASE` (`fire_enrich`);
- the user `DOLT_USER` (`fire_enrich`), which can log in from any address, with
  all privileges on that database and no server-wide privileges;
- `root`, which can log in only from inside the container.

A later change to `dolt.env` does not change an existing user or password.

### 2. Make the TLS certificate

The certificate is self-signed. The app trusts it because you give the app this
exact certificate as its CA (step 5). No public certificate authority is
necessary.

Set `DOLT_TLS_HOST` to the name the app will connect to, which is the value of
`DOLT_HOST`:

```sh
DOLT_TLS_HOST=dolt.example.com
mkdir -p deploy/dolt/certs
openssl req -x509 -newkey rsa:4096 -sha256 -days 825 -nodes \
  -keyout deploy/dolt/certs/server.key -out deploy/dolt/certs/server.crt \
  -subj "/CN=$DOLT_TLS_HOST" -addext "subjectAltName=DNS:$DOLT_TLS_HOST"
chmod 600 deploy/dolt/certs/server.key
```

If the app connects by IP address, use `-subj "/CN=203.0.113.10"` and
`-addext "subjectAltName=IP:203.0.113.10"` (with your address).

`deploy/dolt/dolt.env` and `deploy/dolt/certs/` are gitignored. Do not commit
them.

`deploy/dolt/config.yaml` points `dolt sql-server` at these files and sets
`require_secure_transport: true`, so the server refuses every connection that
does not use TLS.

### 3. Start Dolt

```sh
docker compose -f docker-compose.dolt.yml up -d
docker compose -f docker-compose.dolt.yml logs -f dolt
```

Wait for `Dolt init process done. Ready for connections.` The first start
also logs `Creating database 'fire_enrich'` and
`Creating user 'fire_enrich@%'`.

To stop it, use `docker compose -f docker-compose.dolt.yml down`. The data stays in
the `fire-enrich-dolt_dolt-data` volume. Only `down -v` deletes the data.

### 4. Open port 3306

The app connects to port 3306 over the internet. Vercel Functions have no fixed
outbound IP addresses by default, so usually you cannot restrict the port to
the app's addresses. TLS and the app user's password protect it.

- Allow inbound TCP 3306 in the provider's firewall (the cloud or VPS panel),
  with SSH. Keep every other port closed.
- Docker adds its own iptables rules for published ports, and these rules come
  before `ufw` rules. As a result, `ufw deny 3306` does not block a port that
  Docker publishes. To restrict sources on the host, add rules to the
  `DOCKER-USER` chain, or use the provider's firewall.
- If your app runs from fixed IP addresses, allow 3306 from those addresses
  only.

### 5. Make `DOLT_TLS_CA_B64`

`lib/dolt.ts` decodes `DOLT_TLS_CA_B64` from base64 and passes it to `mysql2`
as `ssl.ca`. `scripts/db-migrate.mjs` does the same thing. The app then accepts
only a server certificate that this CA signed. The variable holds the
certificate that you made in step 2, encoded as base64 on one line:

```sh
base64 -w0 deploy/dolt/certs/server.crt; echo
```

On macOS, use `base64 -i deploy/dolt/certs/server.crt`. This is the
certificate, not the key. Never copy `server.key` off the server.

`mysql2` verifies the certificate chain but not the host name, unless
`ssl.verifyIdentity` is set, and `lib/dolt.ts` does not set it. The trust
comes from the pinned certificate. The name in the certificate is for other
clients that do check it, such as `mysql --ssl-mode=VERIFY_IDENTITY`.

### 6. Set the Vercel environment variables

Set these for Production:

| Variable          | Value                                        |
| ----------------- | -------------------------------------------- |
| `DOLT_HOST`       | the server's DNS name or IP (`$DOLT_TLS_HOST`) |
| `DOLT_PORT`       | `3306`                                       |
| `DOLT_USER`       | `fire_enrich` (`DOLT_USER` in `dolt.env`)    |
| `DOLT_PASSWORD`   | `DOLT_PASSWORD` from `dolt.env`              |
| `DOLT_DATABASE`   | `fire_enrich` (`DOLT_DATABASE` in `dolt.env`) |
| `DOLT_TLS_CA_B64` | the output of step 5                         |

With the Vercel CLI, run `vercel env add <NAME> production` once for each
variable. `DOLT_COMMIT_AUTHOR` is optional (see `.env.example`).

Vercel reads environment variables at build time, so redeploy after you set
them. A production build runs `db:migrate` against this database after
`next build` (see "Database migrations" in `CLAUDE.md`), so the first
production deploy creates the tables. Preview deployments do not migrate
unless `DOLT_PREVIEW_MIGRATE=1` is set. Set that only when Preview uses a
different database from Production.

To apply the schema before the first deploy, run it from any machine with the
same six values set:

```sh
DOLT_HOST=dolt.example.com DOLT_PORT=3306 DOLT_USER=fire_enrich \
DOLT_PASSWORD=... DOLT_DATABASE=fire_enrich \
DOLT_TLS_CA_B64="$(base64 -w0 deploy/dolt/certs/server.crt)" \
npm run db:migrate
```

### Renewing the certificate

The certificate is valid for 825 days. To replace it, repeat step 2, run
`docker compose -f docker-compose.dolt.yml restart dolt`, repeat step 5, update
`DOLT_TLS_CA_B64` in Vercel, and redeploy.

### Upgrading Dolt

Change the image tag in `docker-compose.dolt.yml` together with CI's `migrate`
job, to the same exact tag (see "Database migrations" in `CLAUDE.md`). Never
move the server to a lower version than the one it runs.

## Managed alternative

[Hosted Dolt](https://hosted.doltdb.com) is a paid, managed Dolt server. It is
optional. Put its connection details in the same `DOLT_*` variables.
