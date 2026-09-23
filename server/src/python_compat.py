"""Runtime compatibility settings for supported Python/package combinations."""

import warnings


def configure_runtime_warnings() -> None:
    """Hide the known Pydantic V1-on-Python-3.14 warning from OpenAI's shim.

    FastAPI and the application use Pydantic V2. The OpenAI SDK imports its
    optional V1 compatibility layer, which emits this warning on Python 3.14
    even though the application models do not use Pydantic V1.
    """
    warnings.filterwarnings(
        "ignore",
        message=r"Core Pydantic V1 functionality isn't compatible with Python 3\.14 or greater\.",
        category=UserWarning,
        module=r"openai\._compat",
    )
