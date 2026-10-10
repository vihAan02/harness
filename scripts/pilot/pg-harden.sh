#!/usr/bin/env bash
# Hardens this Mac's loopback Postgres for the pilot (D-119, TH-22). An agent's sandbox may reach loopback ports, and a
# Postgres that trusts loopback logins lets anything there log in as your superuser and run programs outside the
# sandbox (COPY … TO PROGRAM). After this, no login works without a password.
#   - Backs up pg_hba.conf (once, as pg_hba.conf.pre-harness), then sets every local and host line's method from
#     trust to scram-sha-256.
#   - Gives your own superuser role a random password, kept only in ~/.pgpass (0600). psql, `npm run check` and the
#     demos read it from there, so nothing else changes for you.
#   - Creates harness_agent: a login role with no superuser, createdb or createrole, and its own database, for any
#     agent that needs one (through a project secret, D-52). Its URL goes into ~/.harness/secrets.toml (0600).
#   - Checks the result: a password-less login fails, ~/.pgpass works, and harness_agent can't run a program.
# Undo: scripts/pilot/pg-harden.sh --undo restores the backup and clears your role's password.
# Env: PGDATA (default Homebrew postgresql@18's), PGPORT (default 5432), PGBIN, HARNESS_HOME (default ~/.harness).
# Passwords never go on a command line: they reach psql on stdin (or, for the restricted role's own check, in PGPASSWORD).
set -euo pipefail

PGBIN="${PGBIN:-$( (brew --prefix postgresql@18 2>/dev/null || echo /opt/homebrew/opt/postgresql@18) )/bin}"
PGDATA="${PGDATA:-/opt/homebrew/var/postgresql@18}"
PORT="${PGPORT:-5432}"
ME="$(id -un)"
HBA="$PGDATA/pg_hba.conf"
BACKUP="$HBA.pre-harness"
PGPASS="$HOME/.pgpass"
HHOME="${HARNESS_HOME:-$HOME/.harness}"
SECRETS="$HHOME/secrets.toml"

say() { printf '%s\n' "$*"; }
die() { printf 'pg-harden: %s\n' "$*" >&2; exit 1; }
# As your superuser, over loopback TCP, with ~/.pgpass if it has the password. SQL comes on stdin.
su_sql() { "$PGBIN/psql" -X -q -h 127.0.0.1 -p "$PORT" -U "$ME" -d postgres -v ON_ERROR_STOP=1 -At -f -; }
pgpass_password() { [ -f "$PGPASS" ] && awk -F: -v p="$PORT" -v u="$ME" '$1=="127.0.0.1" && $2==p && $4==u { print $5; exit }' "$PGPASS" || true; }

[ -x "$PGBIN/psql" ] || die "no psql in $PGBIN; set PGBIN"
[ -f "$HBA" ] || die "no $HBA; set PGDATA to your cluster's data directory"

if [ "${1:-}" = "--undo" ]; then
  [ -f "$BACKUP" ] || die "no backup at $BACKUP: nothing to undo"
  cp "$BACKUP" "$HBA"
  echo "SELECT pg_reload_conf();" | su_sql >/dev/null
  printf 'ALTER ROLE "%s" PASSWORD NULL;\n' "$ME" | su_sql
  if [ -f "$PGPASS" ]; then
    grep -v -E "^(127\.0\.0\.1|localhost):$PORT:\*:$ME:" "$PGPASS" > "$PGPASS.tmp" || true
    mv "$PGPASS.tmp" "$PGPASS" && chmod 600 "$PGPASS"
  fi
  say "restored $HBA from $BACKUP, cleared $ME's password and its ~/.pgpass lines. Loopback logins are trusted again (D-119 fails)."
  exit 0
fi

# 1. Your role's password: reuse the one ~/.pgpass already holds, so running this twice changes nothing.
PW="$(pgpass_password)"
[ -n "$PW" ] || PW="$(openssl rand -hex 24)"
touch "$PGPASS" && chmod 600 "$PGPASS"
for host in 127.0.0.1 localhost; do
  grep -q -E "^$host:$PORT:\*:$ME:" "$PGPASS" || printf '%s:%s:*:%s:%s\n' "$host" "$PORT" "$ME" "$PW" >> "$PGPASS"
done
printf "SET password_encryption = 'scram-sha-256'; ALTER ROLE \"%s\" PASSWORD '%s';\n" "$ME" "$PW" | su_sql \
  || die "couldn't log in as $ME to set its password; is Postgres running on $PORT?"
say "ok   $ME has a password, kept in $PGPASS (0600)"

# 2. pg_hba.conf: trust becomes scram-sha-256 on every local and host line; the original is kept once.
[ -f "$BACKUP" ] || cp "$HBA" "$BACKUP"
sed -E 's/^((local|host|hostssl|hostnossl)[[:space:]].*[[:space:]])trust[[:space:]]*$/\1scram-sha-256/' "$HBA" > "$HBA.harness-tmp"
mv "$HBA.harness-tmp" "$HBA"
if grep -E '^(local|host|hostssl|hostnossl)[[:space:]]' "$HBA" | grep -q -E '[[:space:]](trust|password|md5)[[:space:]]*$'; then
  die "$HBA still has a trust, password or md5 line; fix it by hand (the original is $BACKUP)"
fi
echo "SELECT pg_reload_conf();" | su_sql >/dev/null
say "ok   $HBA: every loopback login needs a password (backup: $BACKUP)"

# 3. harness_agent: no superuser, no createdb, no createrole; its own database. Its URL is a project secret (D-52).
APW=""
if [ -f "$SECRETS" ]; then APW="$(sed -n -E 's/^HARNESS_AGENT_DATABASE_URL = "postgresql:\/\/harness_agent:([0-9a-f]+)@.*/\1/p' "$SECRETS")"; fi
[ -n "$APW" ] || APW="$(openssl rand -hex 24)"
cat <<SQL | su_sql >/dev/null
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'harness_agent') THEN
    CREATE ROLE harness_agent LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
END \$\$;
ALTER ROLE harness_agent LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '$APW';
SQL
echo "SELECT 1 FROM pg_database WHERE datname = 'harness_agent';" | su_sql | grep -q 1 \
  || echo "CREATE DATABASE harness_agent OWNER harness_agent;" | su_sql
mkdir -p "$HHOME" && chmod 700 "$HHOME"
touch "$SECRETS" && chmod 600 "$SECRETS"
if ! grep -q '^HARNESS_AGENT_DATABASE_URL = ' "$SECRETS"; then
  printf 'HARNESS_AGENT_DATABASE_URL = "postgresql://harness_agent:%s@127.0.0.1:%s/harness_agent"\n' "$APW" "$PORT" >> "$SECRETS"
fi
say "ok   harness_agent: a login with no superuser, createdb or createrole; its URL is in $SECRETS (0600)"

# 4. Check it the way an agent would try: no password, then the restricted role running a program.
if PGPASSFILE=/dev/null "$PGBIN/psql" -X -w -h 127.0.0.1 -p "$PORT" -U "$ME" -d postgres -Atc 'select 1' >/dev/null 2>&1; then
  die "a password-less login as $ME still works on 127.0.0.1:$PORT"
fi
say "ok   a password-less login as $ME is refused"
echo "SELECT 1;" | su_sql | grep -q 1 || die "logging in with ~/.pgpass doesn't work"
say "ok   your own login works through ~/.pgpass"
ERR="$(PGPASSWORD="$APW" PGPASSFILE=/dev/null "$PGBIN/psql" -X -h 127.0.0.1 -p "$PORT" -U harness_agent -d harness_agent -At \
  -c "COPY (SELECT 1) TO PROGRAM 'true'" 2>&1 || true)"
echo "$ERR" | grep -q -i 'permission denied\|must be superuser\|pg_execute_server_program' \
  || die "harness_agent's COPY TO PROGRAM didn't fail as expected: $ERR"
OK="$(PGPASSWORD="$APW" PGPASSFILE=/dev/null "$PGBIN/psql" -X -h 127.0.0.1 -p "$PORT" -U harness_agent -d harness_agent -Atc 'select 1' 2>&1 || true)"
[ "$OK" = "1" ] || die "harness_agent can't log in to its own database: $OK"
say "ok   harness_agent logs in, and can't run a program (COPY … TO PROGRAM is refused)"
if [ "${PGPASSFILE:-}" != "$PGPASS" ]; then
  say "note Some tests point HOME elsewhere (T-1, T-1b), so name the password file absolutely. Add to ~/.zshrc:"
  say "       export PGPASSFILE=\"\$HOME/.pgpass\""
fi
say "Postgres on $PORT is hardened for the pilot (D-119). harness doctor should now pass its postgres check."
