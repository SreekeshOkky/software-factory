# Supabase backend

For repos using Supabase (`supabase/migrations/`, `@supabase/*` or `supabase-py`).
The factory runs a real local stack from `services/supabase.yml`. Combine this
with the app's stack reference (Next, Vite, Python).

## Addresses
| What | Value |
|---|---|
| API URL (auth, REST, storage) | `http://factory-supabase:8000` |
| Postgres | `factory-supabase-db:5432`, database `postgres`, users `postgres` and `supabase_admin` |
| Mail sink | `http://factory-supabase-mail:8025` |
| Secrets | the `x-secrets` block and database password in `services/supabase.yml` |

Not available: Realtime, Edge Functions, image transformation. If the app needs
one, say so and ask.

## What to add to the repo (e.g. under `tests/supabase/`)
1. **`env`**: the values above as defaults, overridable with `FACTORY_SUPABASE_*`.
   Never read the app's own `.env` or `SUPABASE_*` variables: those may point at
   production. The commands in `factory.yml` get a clean environment, so the
   defaults must work with nothing set.
2. **`reset`**, destructive, refusing any database host but `factory-supabase-db`
   unless `FACTORY_SUPABASE_ALLOW_RESET=1`:
   - Wait for `/auth/v1/health` and `/storage/v1/bucket`.
   - As `supabase_admin`: drop and recreate schema `public`; restore its usage
     grant and the default privileges (tables, sequences, functions) to `anon`,
     `authenticated`, `service_role` for roles `postgres` and `supabase_admin`;
     drop policies in schema `storage`; delete `storage.objects` and
     `storage.buckets` with `session_replication_role = replica`; then, back in
     `origin`, delete `auth.users`.
   - As `postgres`: apply `supabase/migrations/*.sql` in name order, one
     transaction per file, naming the file that fails.
   - `notify pgrst, 'reload schema'` and wait for a table to answer over REST.
   - Also handle anything else the migrations create outside `public` (extra
     schemas, publications, cron jobs), or the second run fails.
3. **`seed`**: users through `POST /auth/v1/admin/users` (fixed ids), files
   through the storage API, rows through SQL with fixed ids and dates relative to
   today. Run the app's real promotion or onboarding steps; if the seed needs
   extra inserts to look right, that may be an app bug: report it.
4. **`start`**: reset, seed, build the web app with the public URL and anon key,
   serve it with its API on the `factory.yml` port.

## Tests
- Reset and seed once per test run, and once when the e2e server starts. Tests
  must not depend on each other's data.
- Sign in through Supabase Auth to get real tokens.
- Add a row-level security test that calls `/rest/v1/...` with a user's token,
  bypassing the app's own checks.

## Self-check
Run `reset` twice in a row, then check that a broken migration and a policy that
loosens access each make `test` fail.

## Locally
The stack publishes no ports. Run the commands in a container on the factory's
network, or set `FACTORY_SUPABASE_*` (and `ALLOW_RESET`) to a disposable
`supabase start`. Warn the user that reset wipes it.
