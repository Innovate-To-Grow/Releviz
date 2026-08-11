from unittest.mock import patch

from django.test import SimpleTestCase

from apps.core.services.helpers.in_process import start_in_process_task


class InProcessTaskStartTests(SimpleTestCase):
    @patch("apps.core.services.helpers.in_process.threading.Thread")
    def test_best_effort_start_failure_is_logged_and_suppressed(self, thread_class):
        thread_class.return_value.start.side_effect = RuntimeError("can't start new thread")

        with self.assertLogs("apps.core.services.helpers.in_process", level="ERROR") as logs:
            thread = start_in_process_task(
                lambda: None,
                name="best-effort-test",
                best_effort_start=True,
            )

        self.assertIsNone(thread)
        self.assertIn("Unable to start best-effort in-process task best-effort-test", logs.output[0])

    @patch("apps.core.services.helpers.in_process.threading.Thread")
    def test_required_start_failure_still_reaches_stateful_caller(self, thread_class):
        thread_class.return_value.start.side_effect = RuntimeError("can't start new thread")

        with self.assertRaisesMessage(RuntimeError, "can't start new thread"):
            start_in_process_task(lambda: None, name="required-test")

    @patch("apps.core.services.helpers.in_process.threading.Thread")
    def test_success_returns_started_thread(self, thread_class):
        thread = start_in_process_task(lambda: None, name="success-test")

        self.assertIs(thread, thread_class.return_value)
        thread.start.assert_called_once_with()

    @patch("apps.core.services.helpers.in_process.threading.Thread")
    @patch("apps.core.services.helpers.in_process.close_old_connections")
    def test_task_wrapper_refreshes_connections_before_and_after_success(
        self,
        close_connections,
        thread_class,
    ):
        events = []
        close_connections.side_effect = lambda: events.append("close")

        def target(first, second):
            events.append((first, second))

        start_in_process_task(target, "one", "two", name="connection-test")
        thread_target = thread_class.call_args.kwargs["target"]

        thread_target()

        self.assertEqual(events, ["close", ("one", "two"), "close"])

    @patch("apps.core.services.helpers.in_process.threading.Thread")
    @patch("apps.core.services.helpers.in_process.close_old_connections")
    def test_task_wrapper_logs_target_failure_and_still_closes_connection(
        self,
        close_connections,
        thread_class,
    ):
        def target():
            raise RuntimeError("provider unavailable")

        start_in_process_task(target, name="failure-test")
        thread_target = thread_class.call_args.kwargs["target"]

        with self.assertLogs("apps.core.services.helpers.in_process", level="ERROR") as logs:
            thread_target()

        self.assertEqual(close_connections.call_count, 2)
        self.assertIn("In-process background task failure-test failed", logs.output[0])
