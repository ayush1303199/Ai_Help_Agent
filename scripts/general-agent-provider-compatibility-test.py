import sys
from types import SimpleNamespace

sys.path.insert(0, "server/src")
import index  # noqa: E402


def main():
    primary = SimpleNamespace(
        id="primary",
        type="cohere",
        model="command-r",
        base_url="https://api.cohere.example",
    )
    fallback = SimpleNamespace(
        id="fallback",
        type="openai",
        model="fallback-model",
        base_url="https://api.openai.example/v1",
    )
    statuses = []
    original = {
        "provider_candidates": index.provider_candidates,
        "get_api_key": index.get_api_key,
        "openai": index.OpenAI,
        "update_provider_status": index.registry.update_provider_status,
        "save_to_file": index.registry.save_to_file,
        "fallback_enabled": index.registry.fallback_enabled,
    }

    class FakeCompletions:
        def create(self, **_request):
            return SimpleNamespace(
                choices=[
                    SimpleNamespace(
                        message=SimpleNamespace(role="assistant", content="Fallback provider response.")
                    )
                ]
            )

    class FakeClient:
        def __init__(self, **_kwargs):
            self.chat = SimpleNamespace(completions=FakeCompletions())

    class ToolChoiceProviderError(Exception):
        status_code = 400

    try:
        index.provider_candidates = lambda _provider_id=None: [primary, fallback]
        index.get_api_key = lambda _provider_id: "runtime-test-key"
        index.OpenAI = FakeClient
        index.registry.fallback_enabled = True
        index.registry.update_provider_status = lambda provider_id, status, failure_category=None: statuses.append(
            (provider_id, status, failure_category)
        )
        index.registry.save_to_file = lambda: None

        reason = index.provider_tool_compatibility(primary, index.GENERAL_TOOLS, "required")
        assert reason and "does not support" in reason
        assert index.is_tool_compatibility_error(index.ToolCompatibilityError("cohere", "command-r", reason))

        message, selected = index.complete_model(
            [{"role": "user", "content": "Find a public page."}],
            tools=index.GENERAL_TOOLS,
            tool_choice="required",
            allow_tool_compatibility_fallback=True,
        )
        assert selected.id == "fallback"
        assert message["content"] == "Fallback provider response."
        assert not statuses, "tool compatibility must not persistently downgrade the configured provider"
        assert primary.model == "command-r"

        try:
            index.complete_model(
                [{"role": "user", "content": "Find a public page."}],
                tools=index.GENERAL_TOOLS,
                tool_choice="required",
                allow_tool_compatibility_fallback=False,
            )
        except index.ToolCompatibilityError:
            pass
        else:
            raise AssertionError("tool incompatibility must remain terminal when fallback is disabled")

        class FailingCompletions:
            def create(self, **_request):
                raise ToolChoiceProviderError("Tool choice is none, but model called a tool")

        class FailingClient:
            def __init__(self, **_kwargs):
                self.chat = SimpleNamespace(completions=FailingCompletions())

        index.provider_candidates = lambda _provider_id=None: [fallback]
        index.OpenAI = FailingClient
        try:
            index.complete_model(
                [{"role": "user", "content": "Find a public page."}],
                tools=index.GENERAL_TOOLS,
                tool_choice="auto",
                allow_tool_compatibility_fallback=True,
            )
        except index.ToolCompatibilityError:
            pass
        else:
            raise AssertionError("provider tool-choice failures must retain TOOL_COMPATIBILITY classification")

        retry_provider = SimpleNamespace(
            id="retry-provider",
            type="openai",
            model="retry-model",
            base_url="https://api.openai.example/v1",
        )
        retry_calls = []

        class RateLimitProviderError(Exception):
            status_code = 429

        class RetryCompletions:
            def create(self, **_request):
                retry_calls.append(1)
                if len(retry_calls) == 1:
                    raise RateLimitProviderError("temporary rate limit")
                return SimpleNamespace(
                    choices=[
                        SimpleNamespace(
                            message=SimpleNamespace(role="assistant", content="Recovered after retry.")
                        )
                    ]
                )

        class RetryClient:
            def __init__(self, **_kwargs):
                self.chat = SimpleNamespace(completions=RetryCompletions())

        index.provider_candidates = lambda _provider_id=None: [retry_provider]
        index.OpenAI = RetryClient
        message, selected = index.complete_model(
            [{"role": "user", "content": "Retry this request once."}],
            request_id="provider-retry-test",
        )
        assert selected.id == "retry-provider"
        assert message["content"] == "Recovered after retry."
        assert len(retry_calls) == 2, "transient provider failures must receive one bounded retry"

        print('{"runtime":"general-agent-provider-compatibility","classification":true,"boundedFallback":true,"configurationPreserved":true}')
    finally:
        index.provider_candidates = original["provider_candidates"]
        index.get_api_key = original["get_api_key"]
        index.OpenAI = original["openai"]
        index.registry.update_provider_status = original["update_provider_status"]
        index.registry.save_to_file = original["save_to_file"]
        index.registry.fallback_enabled = original["fallback_enabled"]


if __name__ == "__main__":
    main()
