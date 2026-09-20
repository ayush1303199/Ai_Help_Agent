import asyncio
import sys

sys.path.insert(0, "server/src")
import index  # noqa: E402


async def main():
    captured = []
    original_call_model = index.call_model

    def fake_call_model(messages, request_id=None, trace_metadata=None):
        captured.append((messages, trace_metadata))
        return "Grounded test answer."

    async def send_json(_payload):
        return None

    index.call_model = fake_call_model
    try:
        await index.process_chat_payload(
            {
                "type": "chat",
                "mode": "direct",
                "requestId": "interview-context-test",
                "messages": [
                    {
                        "role": "system",
                        "content": (
                            "INTERVIEW DOMAIN: Software Engineer\n"
                            "TECHNICAL BACKGROUND: Java, Spring Boot\n"
                            "Answer in first person as the candidate.\n"
                        ),
                    },
                    {"role": "user", "content": "CURRENT QUESTION:\nIntroduce yourself"},
                ],
                "interviewContext": {
                    "domain": "Software Engineer",
                    "background": ["Java", "Spring Boot", "Java"],
                    "microphoneDeviceId": "must-not-leak",
                    "microphoneConfigured": True,
                    "microphoneDevicePresent": True,
                },
                "pdfContext": (
                    "Document: Resume: candidate.pdf\nCandidate evidence\n\n"
                    "Document: Job Description: role.pdf\nRole requirements\n\n"
                    "Trained profile: Candidate\nProfile evidence"
                ),
            },
            send_json,
            index.new_connection_state(),
        )
    finally:
        index.call_model = original_call_model

    assert captured, "direct request did not reach the provider boundary"
    messages, metadata = captured[0]
    assert len([item for item in messages if item.get("role") == "system"]) == 1
    assert metadata["domain"] == "Software Engineer"
    assert metadata["domainUsed"] is True
    assert metadata["backgroundCount"] == 2
    assert metadata["backgroundUsed"] is True
    assert metadata["backgroundHash"]
    assert metadata["contextUsed"] is True
    assert metadata["resumeUsed"] is True
    assert metadata["jdUsed"] is True
    assert metadata["profileUsed"] is True
    assert metadata["currentQuestionPresent"] is True
    assert metadata["candidatePersonaInstructionPresent"] is True
    assert metadata["microphoneConfigured"] is True
    assert metadata["microphoneDevicePresent"] is True
    assert "must-not-leak" not in str(messages)
    assert "must-not-leak" not in str(metadata)
    assert metadata["promptChars"] == len(messages[0]["content"])

    print(
        '{"providerBoundary":true,"domainUsed":true,"backgroundUsed":true,'
        '"resumeUsed":true,"jdUsed":true,"profileUsed":true,'
        '"currentQuestionPresent":true,"candidatePersonaInstructionPresent":true,'
        '"microphoneMetadataSafe":true}'
    )


if __name__ == "__main__":
    asyncio.run(main())
