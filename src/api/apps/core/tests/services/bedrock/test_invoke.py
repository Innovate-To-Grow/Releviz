"""Tests for bedrock converse / streaming / stream_parser / prepare / clients."""

from unittest.mock import MagicMock, patch

from botocore.exceptions import ClientError
from django.test import SimpleTestCase, TestCase

from apps.core.services.bedrock.clients.prepare import build_kwargs, prepare
from apps.core.services.bedrock.exceptions import BedrockError
from apps.core.services.bedrock.invoke.converse import collect_tool_results, invoke_bedrock
from apps.core.services.bedrock.invoke.stream_parser import (
    process_stream_response,
    start_content_block,
    stop_content_block,
    stream_tool_results,
)
from apps.core.services.bedrock.invoke.streaming import invoke_bedrock_stream


def _client_error():
    return ClientError({"Error": {"Code": "Boom", "Message": "bad"}}, "Converse")


class FakeChatConfig:
    is_configured = True
    default_model_id = "anthropic.claude-3"
    max_tokens = 1024
    temperature = 0.5
    system_prompt = "You are helpful."


# ---------- prepare / build_kwargs ----------


class BuildKwargsTest(SimpleTestCase):
    def test_includes_system_and_tools(self):
        cfg = FakeChatConfig()
        with patch(
            "apps.core.services.bedrock.clients.prepare.get_tool_definitions",
            return_value=[{"toolSpec": {"name": "x"}}],
        ):
            kwargs = build_kwargs(cfg, "model-1")
        self.assertEqual(kwargs["modelId"], "model-1")
        self.assertEqual(kwargs["inferenceConfig"], {"maxTokens": 1024, "temperature": 0.5})
        self.assertEqual(kwargs["system"], [{"text": "You are helpful."}])
        self.assertIn("toolConfig", kwargs)

    def test_omits_system_and_tools_when_empty(self):
        cfg = FakeChatConfig()
        cfg.system_prompt = ""
        with patch(
            "apps.core.services.bedrock.clients.prepare.get_tool_definitions", return_value=[]
        ):
            kwargs = build_kwargs(cfg, "model-1")
        self.assertNotIn("system", kwargs)
        self.assertNotIn("toolConfig", kwargs)


class PrepareTest(SimpleTestCase):
    def test_raises_when_chat_config_not_configured(self):
        bad_cfg = MagicMock()
        bad_cfg.is_configured = False
        with self.assertRaises(BedrockError) as cm:
            prepare([{"role": "user", "content": "hi"}], bad_cfg, MagicMock(), "m")
        self.assertIn("AI Chat is not configured", str(cm.exception))

    def test_loads_default_config_and_model_and_builds_messages(self):
        loaded = FakeChatConfig()
        with (
            patch(
                "apps.core.services.bedrock.clients.prepare.SystemIntelligenceConfig.load",
                return_value=loaded,
            ),
            patch("apps.core.services.bedrock.clients.prepare.get_client", return_value="CLIENT"),
            patch(
                "apps.core.services.bedrock.clients.prepare.get_tool_definitions", return_value=[]
            ),
        ):
            client, messages, kwargs = prepare(
                [{"role": "user", "content": "hello"}],
                None,
                MagicMock(),
                None,
            )
        self.assertEqual(client, "CLIENT")
        self.assertEqual(messages, [{"role": "user", "content": [{"text": "hello"}]}])
        # model_id falls back to chat_config.default_model_id
        self.assertEqual(kwargs["modelId"], "anthropic.claude-3")


# ---------- clients ----------


class ClientsTest(TestCase):
    def test_get_aws_config_raises_when_unconfigured(self):
        from apps.core.services.bedrock.clients import get_aws_config

        cfg = MagicMock()
        cfg.is_configured = False
        with self.assertRaises(BedrockError) as cm:
            get_aws_config(cfg)
        self.assertIn("AWS credentials are not configured", str(cm.exception))

    def test_get_aws_config_loads_default(self):
        from apps.core.services.bedrock.clients import get_aws_config

        loaded = MagicMock()
        loaded.is_configured = True
        with patch(
            "apps.core.services.bedrock.clients._aws.AWSCredentialConfig.load",
            return_value=loaded,
        ):
            self.assertIs(get_aws_config(None), loaded)

    def test_get_client_builds_runtime_client(self):
        from apps.core.services.bedrock.clients import get_client

        cfg = MagicMock()
        cfg.is_configured = True
        cfg.region = "us-west-2"
        cfg.access_key_id = "AKIA"
        cfg.get_secret_access_key.return_value = "sek"
        with patch(
            "apps.core.services.bedrock.clients._aws.boto3.client", return_value="RT"
        ) as boto:
            self.assertEqual(get_client(cfg), "RT")
        boto.assert_called_once_with(
            "bedrock-runtime",
            region_name="us-west-2",
            aws_access_key_id="AKIA",
            aws_secret_access_key="sek",
        )

    def test_get_management_client_builds_bedrock_client(self):
        from apps.core.services.bedrock.clients import get_management_client

        cfg = MagicMock()
        cfg.is_configured = True
        cfg.region = "eu-west-1"
        cfg.access_key_id = "AKIA"
        cfg.get_secret_access_key.return_value = "sek"
        with patch(
            "apps.core.services.bedrock.clients._aws.boto3.client", return_value="MGMT"
        ) as boto:
            self.assertEqual(get_management_client(cfg), "MGMT")
        boto.assert_called_once_with(
            "bedrock",
            region_name="eu-west-1",
            aws_access_key_id="AKIA",
            aws_secret_access_key="sek",
        )

    def test_get_cloudwatch_client_builds_cloudwatch_client(self):
        from apps.core.services.bedrock.clients import get_cloudwatch_client

        cfg = MagicMock()
        cfg.is_configured = True
        cfg.region = "us-west-2"
        cfg.access_key_id = "AKIA"
        cfg.get_secret_access_key.return_value = "sek"
        with patch(
            "apps.core.services.bedrock.clients._aws.boto3.client", return_value="CW"
        ) as boto:
            self.assertEqual(get_cloudwatch_client(cfg), "CW")
        # Never Cost Explorer ("ce") -- CloudWatch reads only.
        boto.assert_called_once_with(
            "cloudwatch",
            region_name="us-west-2",
            aws_access_key_id="AKIA",
            aws_secret_access_key="sek",
        )


# ---------- converse (non-streaming) ----------


class InvokeBedrockTest(SimpleTestCase):
    def _prep(self, client):
        return patch(
            "apps.core.services.bedrock.invoke.converse.prepare",
            return_value=(client, [], {"modelId": "m"}),
        )

    def test_returns_text_on_end_turn(self):
        client = MagicMock()
        client.converse.return_value = {
            "output": {
                "message": {"role": "assistant", "content": [{"text": "Hi "}, {"text": "there"}]}
            },
            "stopReason": "end_turn",
        }
        with self._prep(client):
            result = invoke_bedrock([{"role": "user", "content": "hey"}])
        self.assertEqual(result["text"], "Hi there")
        self.assertEqual(result["tool_calls"], [])

    def test_tool_use_loop_then_final_text(self):
        client = MagicMock()
        tool_msg = {
            "role": "assistant",
            "content": [{"toolUse": {"toolUseId": "t1", "name": "get_stuff", "input": {"q": 1}}}],
        }
        final_msg = {"role": "assistant", "content": [{"text": "done"}]}
        client.converse.side_effect = [
            {"output": {"message": tool_msg}, "stopReason": "tool_use"},
            {"output": {"message": final_msg}, "stopReason": "end_turn"},
        ]
        with (
            self._prep(client),
            patch("apps.core.services.bedrock.invoke.converse.execute_tool", return_value="RESULT"),
        ):
            result = invoke_bedrock([{"role": "user", "content": "hey"}])
        self.assertEqual(result["text"], "done")
        self.assertEqual(len(result["tool_calls"]), 1)
        self.assertEqual(result["tool_calls"][0]["name"], "get_stuff")
        self.assertEqual(result["tool_calls"][0]["result_preview"], "RESULT")

    def test_client_error_wrapped(self):
        client = MagicMock()
        client.converse.side_effect = _client_error()
        with self._prep(client), self.assertRaises(BedrockError) as cm:
            invoke_bedrock([{"role": "user", "content": "x"}])
        self.assertIn("Bedrock API error", str(cm.exception))

    def test_unexpected_error_wrapped(self):
        client = MagicMock()
        client.converse.side_effect = RuntimeError("kaboom")
        with self._prep(client), self.assertRaises(BedrockError) as cm:
            invoke_bedrock([{"role": "user", "content": "x"}])
        self.assertIn("Unexpected error", str(cm.exception))

    def test_exhausts_tool_rounds(self):
        client = MagicMock()
        tool_msg = {
            "role": "assistant",
            "content": [{"toolUse": {"toolUseId": "t1", "name": "loop", "input": {}}}],
        }
        client.converse.return_value = {"output": {"message": tool_msg}, "stopReason": "tool_use"}
        with (
            self._prep(client),
            patch("apps.core.services.bedrock.invoke.converse.execute_tool", return_value="R"),
        ):
            result = invoke_bedrock([{"role": "user", "content": "x"}])
        self.assertIn("unable to complete the request", result["text"])
        self.assertEqual(len(result["tool_calls"]), 10)

    def test_collect_tool_results_skips_text_blocks(self):
        log = []
        output_message = {
            "content": [
                {"text": "ignore me"},
                {"toolUse": {"toolUseId": "t1", "name": "n", "input": {"a": 1}}},
            ]
        }
        with patch(
            "apps.core.services.bedrock.invoke.converse.execute_tool", return_value="X" * 300
        ):
            results = collect_tool_results(output_message, log)
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0]["toolResult"]["toolUseId"], "t1")
        self.assertEqual(len(log[0]["result_preview"]), 200)  # truncated to 200


# ---------- stream_parser ----------


class StreamHelpersTest(SimpleTestCase):
    def test_process_stream_response_text_and_metadata(self):
        response = {
            "stream": [
                {"contentBlockStart": {"start": {}}},
                {"contentBlockDelta": {"delta": {"text": "Hel"}}},
                {"contentBlockDelta": {"delta": {"text": "lo"}}},
                {"contentBlockStop": {}},
                {"messageStop": {"stopReason": "end_turn"}},
                {
                    "metadata": {
                        "usage": {
                            "inputTokens": 3,
                            "outputTokens": 5,
                            "totalTokens": 8,
                            "cacheReadInputTokens": 4,
                            "cacheWriteInputTokens": 2,
                        }
                    }
                },
            ]
        }
        gen = process_stream_response(response)
        chunks = list(gen)
        # generator yields text chunks then returns outcome via StopIteration.value
        self.assertEqual(
            chunks, [{"type": "text", "chunk": "Hel"}, {"type": "text", "chunk": "lo"}]
        )
        # Re-run to capture the return value
        outcome = self._drain(process_stream_response(response))
        self.assertEqual(outcome["stop_reason"], "end_turn")
        self.assertEqual(
            outcome["usage"],
            {
                "inputTokens": 3,
                "outputTokens": 5,
                "totalTokens": 8,
                "cacheReadInputTokens": 4,
                "cacheWriteInputTokens": 2,
            },
        )
        self.assertEqual(outcome["content_blocks"], [{"text": "Hello"}])

    def test_process_stream_response_tool_use(self):
        response = {
            "stream": [
                {"contentBlockStart": {"start": {"toolUse": {"toolUseId": "t1", "name": "fn"}}}},
                {"contentBlockDelta": {"delta": {"toolUse": {"input": '{"a":'}}}},
                {"contentBlockDelta": {"delta": {"toolUse": {"input": "1}"}}}},
                {"contentBlockStop": {}},
                {"messageStop": {"stopReason": "tool_use"}},
            ]
        }
        outcome = self._drain(process_stream_response(response))
        self.assertEqual(outcome["stop_reason"], "tool_use")
        block = outcome["content_blocks"][0]
        self.assertEqual(block["toolUse"]["input"], {"a": 1})
        self.assertEqual(block["toolUse"]["name"], "fn")

    def test_start_content_block_text(self):
        block, buf = start_content_block({"contentBlockStart": {"start": {}}})
        self.assertEqual(block, {"type": "text", "text": ""})
        self.assertEqual(buf, "")

    def test_start_content_block_tool(self):
        block, buf = start_content_block(
            {"contentBlockStart": {"start": {"toolUse": {"toolUseId": "t9", "name": "z"}}}}
        )
        self.assertEqual(block["type"], "toolUse")
        self.assertEqual(block["toolUseId"], "t9")
        self.assertEqual(buf, "")

    def test_stop_content_block_invalid_json_defaults_empty(self):
        block = stop_content_block({"type": "toolUse", "toolUseId": "t", "name": "n"}, "not-json")
        self.assertEqual(block["toolUse"]["input"], {})

    def test_stop_content_block_text(self):
        block = stop_content_block({"type": "text", "text": "abc"}, "")
        self.assertEqual(block, {"text": "abc"})

    def test_stream_tool_results_yields_events_and_results(self):
        blocks = [
            {"text": "ignored"},
            {"toolUse": {"toolUseId": "t1", "name": "do_it", "input": {"k": "v"}}},
        ]
        with patch(
            "apps.core.services.bedrock.invoke.stream_parser.execute_tool",
            return_value="Z" * 250,
        ):
            outputs = list(stream_tool_results(blocks, round_num=2))
        self.assertEqual(len(outputs), 1)
        event, result = outputs[0]
        self.assertEqual(event["type"], "tool_call")
        self.assertEqual(event["name"], "do_it")
        self.assertEqual(len(event["result_preview"]), 200)
        self.assertEqual(result["toolResult"]["toolUseId"], "t1")

    @staticmethod
    def _drain(gen):
        """Exhaust a generator and return the value carried by StopIteration."""
        try:
            while True:
                next(gen)
        except StopIteration as stop:
            return stop.value


# ---------- streaming ----------


class InvokeBedrockStreamTest(SimpleTestCase):
    def test_prepare_error_yields_error_event(self):
        with patch(
            "apps.core.services.bedrock.invoke.streaming.prepare",
            side_effect=BedrockError("nope"),
        ):
            events = list(invoke_bedrock_stream([{"role": "user", "content": "x"}]))
        self.assertEqual(events, [{"type": "error", "error": "nope"}])

    def test_client_error_yields_error_event(self):
        client = MagicMock()
        client.converse_stream.side_effect = _client_error()
        with patch(
            "apps.core.services.bedrock.invoke.streaming.prepare",
            return_value=(client, [], {}),
        ):
            events = list(invoke_bedrock_stream([{"role": "user", "content": "x"}]))
        self.assertEqual(events[0]["type"], "error")
        self.assertIn("Bedrock API error", events[0]["error"])

    def test_unexpected_error_yields_error_event(self):
        client = MagicMock()
        client.converse_stream.side_effect = RuntimeError("boom")
        with patch(
            "apps.core.services.bedrock.invoke.streaming.prepare",
            return_value=(client, [], {}),
        ):
            events = list(invoke_bedrock_stream([{"role": "user", "content": "x"}]))
        self.assertEqual(events[0]["type"], "error")
        self.assertIn("Unexpected error", events[0]["error"])

    def test_text_stream_then_end(self):
        client = MagicMock()
        client.converse_stream.return_value = {"stream": []}
        outcome = {
            "content_blocks": [{"text": "hi"}],
            "stop_reason": "end_turn",
            "usage": {"inputTokens": 1, "outputTokens": 2, "totalTokens": 3},
        }

        def fake_process(_response):
            yield {"type": "text", "chunk": "hi"}
            return outcome

        with (
            patch(
                "apps.core.services.bedrock.invoke.streaming.prepare", return_value=(client, [], {})
            ),
            patch(
                "apps.core.services.bedrock.invoke.streaming.process_stream_response",
                side_effect=fake_process,
            ),
        ):
            events = list(invoke_bedrock_stream([{"role": "user", "content": "x"}]))
        types = [e["type"] for e in events]
        self.assertIn("text", types)
        self.assertIn("usage", types)

    def test_tool_use_round_then_end(self):
        client = MagicMock()
        client.converse_stream.return_value = {"stream": []}
        outcome_tool = {
            "content_blocks": [{"toolUse": {"toolUseId": "t1", "name": "n", "input": {}}}],
            "stop_reason": "tool_use",
            "usage": {"inputTokens": 0, "outputTokens": 0, "totalTokens": 0},
        }
        outcome_end = {
            "content_blocks": [{"text": "fin"}],
            "stop_reason": "end_turn",
            "usage": {"inputTokens": 0, "outputTokens": 0, "totalTokens": 0},
        }
        outcomes = iter([outcome_tool, outcome_end])

        def fake_process_gen(_response):
            if False:
                yield
            return next(outcomes)

        with (
            patch(
                "apps.core.services.bedrock.invoke.streaming.prepare", return_value=(client, [], {})
            ),
            patch(
                "apps.core.services.bedrock.invoke.streaming.process_stream_response",
                side_effect=fake_process_gen,
            ),
            patch(
                "apps.core.services.bedrock.invoke.streaming.stream_tool_results",
                return_value=[({"type": "tool_call", "name": "n"}, {"toolResult": {}})],
            ),
        ):
            events = list(invoke_bedrock_stream([{"role": "user", "content": "x"}]))
        types = [e["type"] for e in events]
        self.assertIn("tool_call", types)
        self.assertIn("usage", types)

    def test_too_many_tool_rounds(self):
        client = MagicMock()
        client.converse_stream.return_value = {"stream": []}
        outcome_tool = {
            "content_blocks": [{"toolUse": {"toolUseId": "t1", "name": "n", "input": {}}}],
            "stop_reason": "tool_use",
            "usage": {"inputTokens": 0, "outputTokens": 0, "totalTokens": 0},
        }

        def fake_process_gen(_response):
            if False:
                yield
            return outcome_tool

        with (
            patch(
                "apps.core.services.bedrock.invoke.streaming.prepare", return_value=(client, [], {})
            ),
            patch(
                "apps.core.services.bedrock.invoke.streaming.process_stream_response",
                side_effect=fake_process_gen,
            ),
            patch(
                "apps.core.services.bedrock.invoke.streaming.stream_tool_results",
                return_value=[],
            ),
        ):
            events = list(invoke_bedrock_stream([{"role": "user", "content": "x"}]))
        self.assertEqual(events[-1], {"type": "error", "error": "Too many tool-use rounds."})
