# Services

Backends that some target repos need for their tests and running app. Each
stack is its own compose file, so a factory only runs what its repos use and
`docker-compose.yml` stays the same.

## First choose whether you need one

1. SQLite or no backend: nothing here. The repo handles it.
2. One simple service the repo can start itself (a dev dependency that runs as a
   normal user): the repo handles it.
3. A stack in the table below: enable it.
4. Anything else: add a file here through a reviewed PR.

| Stack | File | Reached at (from inside the factory) |
| --- | --- | --- |
| Supabase: Postgres, Auth, REST, Storage, mail sink | `supabase.yml` | `http://factory-supabase:8000`, database `factory-supabase-db:5432`, mail `http://factory-supabase-mail:8025` |

## Enable
Add to `.env`, listing every stack you need, separated by `:`
```bash
COMPOSE_FILE=docker-compose.yml:services/supabase.yml
```
Then `docker compose up -d --build`. Check with `docker compose ps`.

## Rules for a stack file
- Pin image versions. Paths are relative to the repository root.
- Publish no ports, mount no Docker socket, and don't run privileged containers.
- Prefix service names with `factory-<stack>`.
- Only fixed test secrets. **Agents can reach these services and know the
  secrets**, so never put real data or real credentials in them.
- Add `depends_on` for the `factory` service.
- The repo, not the factory, resets and seeds the data from its `test` and
  `start` commands.

## Limits
- One shared instance per stack. This is safe because the factory runs one stage
  at a time. Don't point two factories or a developer at the same instance.
- The factory doesn't start a stack just because a repo needs it: enable it.

## Supabase notes
Image versions are pinned in `supabase.yml`; update them together to the set a
current `supabase start` uses. It has no Realtime, Edge Functions, Studio or
image transformation. Recreate it from scratch with
`docker compose rm -sfv factory-supabase-db && docker compose up -d`.
