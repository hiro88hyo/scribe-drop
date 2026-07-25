# ScribeDrop RunPod Worker

Python 3.12 と uv で管理する RunPod Serverless worker。

```bash
uv sync --frozen
uv run ruff check .
uv run ruff format --check .
uv run mypy --strict src tests
uv run pytest
```
