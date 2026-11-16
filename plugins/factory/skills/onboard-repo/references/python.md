# Python harness

Layers: pytest for units and the HTTP API (framework test client), plus Playwright
(`pytest-playwright`) only if the repo serves a UI. `mypy` or `pyright` for static
checks if the repo already uses type hints consistently. `ruff check` if Ruff is
configured.

## Survey hints
- Packaging: `pyproject.toml` (uv, Poetry, PDM, hatch, setuptools), `requirements*.txt`,
  `uv.lock` / `poetry.lock`. The install command follows the lockfile tool.
- Framework: FastAPI / Flask / Django / CLI / library. App factory or module-level app?
- Python version: `requires-python`, `.python-version`.
- Settings and secrets: pydantic-settings, `os.environ`, `.env`. Tests need safe defaults.
- Database: SQLite (fine in tests), Postgres (needs a service: say so in the PR),
  migrations (Alembic, Django).
- Existing tests: `tests/`, `conftest.py`, `[tool.pytest.ini_options]`.

## Packages
Add to the dev dependency group the repo already uses:
```bash
uv add --dev pytest pytest-cov httpx      # or: poetry add -G dev …, or requirements-dev.txt
# UI only:
uv add --dev pytest-playwright && uv run playwright install chromium
```

## Config (`pyproject.toml`)
```toml
[tool.pytest.ini_options]
testpaths = ["tests"]
addopts = "-q"
markers = ["e2e: browser tests against the running app"]
```

## Seed tests
- Unit: a real pure function from the package.
- API (FastAPI):
  ```python
  from fastapi.testclient import TestClient
  from app.main import app

  def test_health():
      r = TestClient(app).get("/health")
      assert r.status_code == 200
  ```
  Flask: `app.test_client()`. Django: `pytest-django` and the `client` fixture.
- Override settings and dependencies in `conftest.py` (FastAPI `app.dependency_overrides`,
  a temporary SQLite URL) so tests need no secrets or network.
- E2E (UI only): a `conftest.py` fixture that starts the server with `subprocess` on a
  free port and waits for the ready path, then `page.goto(base_url)`. Mark with `@pytest.mark.e2e`.

## `factory.yml`
```yaml
install: "uv sync --frozen"                         # or: poetry install --no-interaction, pip install -r requirements-dev.txt
check: "uv run ruff check . && uv run mypy ."       # only the tools the repo already uses
test: "uv run pytest"
start: "uv run uvicorn app.main:app --host 0.0.0.0 --port 8000"   # gunicorn / manage.py runserver --noreload
port: 8000
ready_path: "/health"                               # any GET that returns 200 without auth
```
If no unauthenticated 200 route exists, propose adding `/health` in the PR. That is a
source change, so list it explicitly.
