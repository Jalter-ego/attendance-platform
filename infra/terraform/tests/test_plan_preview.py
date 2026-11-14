import argparse
from contextlib import redirect_stderr, redirect_stdout
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location("plan_preview", Path(__file__).resolve().parents[1] / "plan_preview.py")
preview = importlib.util.module_from_spec(spec)
spec.loader.exec_module(preview)


def resource(kind, actions, before=None, after=None, **extra):
    return {
        "address": f"module.tenant.{kind}.app",
        "type": kind,
        "mode": "managed",
        "change": {"actions": actions, "before": before, "after": after, **extra},
    }


def plan(*resources, **extra):
    return {"format_version": "1.2", "planned_values": {}, "resource_changes": list(resources), **extra}


class PlanPreviewTests(unittest.TestCase):
    def test_both_replacement_orders_include_deletion(self):
        for actions in (["delete", "create"], ["create", "delete"]):
            with self.subTest(actions=actions):
                result = preview.summarize(plan(resource("aws_instance", actions, {
                    "ami": "ami-old", "root_block_device": [{"delete_on_termination": True}],
                }, {"ami": "ami-new"})))
                self.assertEqual([result["totals"][key] for key in ("create", "delete", "replace")], [1, 1, 1])
                self.assertTrue(result["has_deletions"])
                self.assertIn("root_volume_deleted", result["changes"][0]["risks"])

    def test_destroy_identifies_loss_of_separate_database_disk(self):
        disk = resource("aws_ebs_volume", ["delete"], {"size": 20})
        result = preview.summarize(plan(disk, resource("aws_volume_attachment", ["delete"], {})))
        self.assertEqual(result["data_volumes_deleted"], [disk["address"]])
        self.assertIn("pueden perder sus datos", preview.render_text(result))
        self.assertIn("volume_detached", result["changes"][1]["risks"])

    def test_iam_only_update_does_not_claim_service_interruption(self):
        result = preview.summarize(plan(resource("aws_iam_role_policy", ["update"],
            {"policy": "private-before"}, {"policy": "private-after"})))
        self.assertFalse(result["has_deletions"])
        self.assertEqual(result["changes"][0]["risks"], [])
        self.assertEqual(result["changes"][0]["changed_attributes"], ["policy"])
        self.assertNotIn("private-", json.dumps(result))

    def test_suspend_preserves_storage_but_reports_unavailable_service(self):
        result = preview.summarize(plan(resource("aws_ec2_instance_state", ["update"],
            {"state": "running"}, {"state": "stopped"})))
        self.assertFalse(result["has_deletions"])
        self.assertEqual(result["data_volumes_deleted"], [])
        self.assertIn("instance_stopped", result["changes"][0]["risks"])

    def test_resize_shows_instance_types_and_possible_downtime(self):
        result = preview.summarize(plan(resource("aws_instance", ["update"],
            {"instance_type": "t3.micro"}, {"instance_type": "t3.small"})))
        self.assertIn("t3.micro", preview.render_text(result))
        self.assertIn("t3.small", preview.render_text(result))
        self.assertIn("instance_reconfigured", result["changes"][0]["risks"])

    def test_secret_values_are_excluded_even_from_whitelisted_fields(self):
        result = preview.summarize(plan(resource("aws_instance", ["update"],
            {"ami": "private-before", "user_data": "private-user-data"},
            {"ami": "private-after", "user_data": "private-user-data-new"},
            before_sensitive=True, after_sensitive={"ami": True}),
            variables={"password": {"value": "private-variable"}},
            output_changes={"credentials": {"actions": ["update"], "after": "private-output"}}))
        self.assertNotIn("private-", json.dumps(result))
        self.assertNotIn("private-", preview.render_text(result))
        self.assertEqual(result["changes"][0]["details"]["ami"], {"before": "<sensible>", "after": "<sensible>"})
        self.assertEqual(result["outputs_changed"], ["credentials"])

    def test_sensitivity_on_one_side_protects_both_values(self):
        result = preview.summarize(plan(resource("aws_instance", ["update"],
            {"ami": "private-before"}, {"ami": "private-after"}, before_sensitive={"ami": True})))
        self.assertNotIn("private-", json.dumps(result))

    def test_unknown_after_value_is_not_presented_as_deleted_or_known(self):
        result = preview.summarize(plan(resource("aws_instance", ["create"], after={}, after_unknown={"ami": True})))
        self.assertEqual(result["changes"][0]["details"]["ami"]["after"], "<conocido al aplicar>")

    def test_noop_is_omitted_and_output_only_changes_are_reported(self):
        result = preview.summarize(plan(resource("aws_instance", ["no-op"], {}, {}),
            output_changes={"urls": {"actions": ["update"], "after": "private-output"}}))
        self.assertEqual(result["changes"], [])
        self.assertEqual(result["outputs_changed"], ["urls"])
        self.assertNotIn("private-output", preview.render_text(result))

    def test_moves_and_imports_are_not_misreported_as_creation(self):
        moved = resource("aws_instance", ["no-op"], {}, {})
        moved["previous_address"] = "aws_instance.previous"
        imported = resource("aws_ebs_volume", ["no-op"], {}, {}, importing={"id": "private-import-id"})
        result = preview.summarize(plan(moved, imported))
        self.assertEqual([item["action"] for item in result["changes"]], ["move", "import"])
        self.assertEqual(result["totals"]["create"], 0)
        self.assertNotIn("private-import-id", json.dumps(result))

    def test_incomplete_or_failed_plan_is_explicit(self):
        result = preview.summarize(plan(resource("aws_instance", ["create"], after={}),
            complete=False, errored=True, applyable=False))
        self.assertEqual(len(result["warnings"]), 3)
        self.assertIn("no debe aplicarse", preview.render_text(result))

    def test_rejects_state_new_major_version_and_unsupported_actions(self):
        for source in (
            {"format_version": "1.0", "values": {}},
            plan(format_version="2.0"),
            plan(resource("aws_instance", ["unsupported"])),
            plan(complete={"unexpected": "private-value"}),
            plan(resource("aws_instance", ["create"], after_sensitive="invalid")),
        ):
            with self.subTest(source=source), self.assertRaises(preview.PreviewError):
                preview.summarize(source)

    def test_cli_json_and_invalid_input_do_not_echo_values(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "plan.json"
            for contents, expected_code in ((json.dumps(plan()), 0), ("private-invalid-json", 1)):
                path.write_text(contents)
                out, err = io.StringIO(), io.StringIO()
                with redirect_stdout(out), redirect_stderr(err):
                    code = preview.main(["--json-file", str(path), "--output", "json"])
                self.assertEqual(code, expected_code)
                self.assertNotIn("private-invalid", out.getvalue() + err.getvalue())
                if code == 0:
                    self.assertEqual(json.loads(out.getvalue())["summary_version"], 1)

    def test_binary_reader_only_calls_show_and_hides_engine_errors(self):
        with tempfile.TemporaryDirectory(prefix="plan con espacios ") as directory:
            path = Path(directory) / "saved.tfplan"
            path.touch()
            args = argparse.Namespace(json_file=None, plan=str(path), directory=directory, engine="terraform")
            with patch.object(preview.subprocess, "run", return_value=SimpleNamespace(returncode=0, stdout=json.dumps(plan()))) as run:
                self.assertEqual(preview.load_plan(args)["format_version"], "1.2")
                self.assertEqual(run.call_args.args[0], ["terraform", f"-chdir={directory}", "show", "-json", str(path)])
                self.assertEqual(run.call_args.kwargs["timeout"], 60)
            for result in (SimpleNamespace(returncode=1, stderr="private-engine-error"),
                           subprocess.TimeoutExpired(["private-command"], 60)):
                options = {"side_effect": result} if isinstance(result, Exception) else {"return_value": result}
                with patch.object(preview.subprocess, "run", **options), self.assertRaises(preview.PreviewError) as caught:
                    preview.load_plan(args)
                self.assertNotIn("private-", str(caught.exception))


if __name__ == "__main__":
    unittest.main()
