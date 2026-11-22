"""Unit tests for the SMTP rotation function. No AWS access: clients are fakes.

Run: python3 -m unittest discover -s apps/dad-main/lambda/smtp-rotation
"""

import base64
import hashlib
import hmac
import json
import os
import unittest
from unittest import mock

import index

REGION = "us-east-2"


def doc_pseudocode(key: str, region: str) -> str:
    """AWS's published pseudocode, transcribed literally and independently of index.py:
    kDate = HmacSha256(date, "AWS4" + key); ... Base64(Concatenate(version, kMessage))."""

    def HmacSha256(data, k):
        return hmac.new(k, data.encode("utf-8"), hashlib.sha256).digest()

    k_date = HmacSha256("11111111", ("AWS4" + key).encode("utf-8"))
    k_region = HmacSha256(region, k_date)
    k_service = HmacSha256("ses", k_region)
    k_terminal = HmacSha256("aws4_request", k_service)
    k_message = HmacSha256("SendRawEmail", k_terminal)
    return base64.b64encode(bytes([0x04]) + k_message).decode()


class NotFound(Exception):
    pass


class FakeSecrets:
    """Just enough of Secrets Manager for a rotation."""

    class exceptions:
        ResourceNotFoundException = NotFound

    def __init__(self, current: dict, rotation_enabled=True):
        self.rotation_enabled = rotation_enabled
        self.values = {"v-current": json.dumps(current)}
        self.stages = {"v-current": ["AWSCURRENT"]}

    def stage(self, token):
        self.stages.setdefault(token, []).append("AWSPENDING")

    def describe_secret(self, SecretId):
        return {"RotationEnabled": self.rotation_enabled, "VersionIdsToStages": self.stages}

    def get_secret_value(self, SecretId, VersionId=None, VersionStage=None):
        for vid, stages in self.stages.items():
            if (VersionId is None or vid == VersionId) and VersionStage in stages and vid in self.values:
                return {"SecretString": self.values[vid]}
        raise NotFound()

    def put_secret_value(self, SecretId, ClientRequestToken, SecretString, VersionStages):
        self.values[ClientRequestToken] = SecretString
        for s in VersionStages:
            if s not in self.stages.setdefault(ClientRequestToken, []):
                self.stages[ClientRequestToken].append(s)

    def update_secret_version_stage(self, SecretId, VersionStage, MoveToVersionId, RemoveFromVersionId=None):
        if RemoveFromVersionId is not None:
            self.stages[RemoveFromVersionId].remove(VersionStage)
        self.stages[MoveToVersionId] = [VersionStage]


class FakeIam:
    def __init__(self, keys):
        self.keys = list(keys)
        self.created = 0
        self.deleted = []

    def list_access_keys(self, UserName):
        return {"AccessKeyMetadata": [{"AccessKeyId": k} for k in self.keys]}

    def delete_access_key(self, UserName, AccessKeyId):
        self.keys.remove(AccessKeyId)
        self.deleted.append(AccessKeyId)

    def create_access_key(self, UserName):
        if len(self.keys) >= 2:
            raise RuntimeError("LimitExceeded: a user can have at most 2 access keys")
        self.created += 1
        kid = f"AKIANEW{self.created}"
        self.keys.append(kid)
        return {"AccessKey": {"AccessKeyId": kid, "SecretAccessKey": f"secret-{kid}"}}


class ClusterNotFound(Exception):
    pass


class FakeEcs:
    class exceptions:
        ClusterNotFoundException = ClusterNotFound

    def __init__(self, services, cluster_exists=True):
        self.services = services
        self.cluster_exists = cluster_exists
        self.updated = []

    def describe_services(self, cluster, services):
        if not self.cluster_exists:
            # Real ECS raises for a missing cluster; it does not return an empty list.
            raise ClusterNotFound("Cluster not found.")
        return {"services": [s for s in self.services if s["serviceName"] in services]}

    def update_service(self, cluster, service, forceNewDeployment):
        self.updated.append((cluster, service, forceNewDeployment))


BASE = {
    "DONOR_SMTP_HOST": "email-smtp.us-east-2.amazonaws.com",
    "DONOR_SMTP_PORT": "587",
    "DONOR_EMAIL_FROM": "no-reply@mail.staging.dynamicaid.org",
}
ENV = {
    "SMTP_USER_NAME": "dad-staging-ses-smtp",
    "SES_REGION": REGION,
    "CLUSTER_NAME": "dad-staging",
    "MAIL_SERVICES": "login-email-worker,email-change-worker,message-worker",
}


def rotate(sm, iam, ecs, token="v-new", login=None, sleep=lambda s: None):
    sm.stage(token)
    logins = []
    login = login or (lambda *a: logins.append(a))
    for step in ("createSecret", "setSecret", "testSecret", "finishSecret"):
        index.handler(
            {"SecretId": "arn", "ClientRequestToken": token, "Step": step},
            None, sm=sm, iam=iam, ecs=ecs, smtp_login=login, sleep=sleep,
        )
    return logins


@mock.patch.dict(os.environ, ENV, clear=False)
class RotationTest(unittest.TestCase):
    def test_password_matches_aws_documented_algorithm(self):
        for key in ["wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "x", "a+b/c=d"]:
            for region in [REGION, "us-west-2"]:
                self.assertEqual(index.smtp_password(key, region), doc_pseudocode(key, region))

    def test_password_shape_is_version_byte_plus_sha256(self):
        raw = base64.b64decode(index.smtp_password("wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", REGION))
        self.assertEqual(len(raw), 33)
        self.assertEqual(raw[0], 0x04)
        # Region-specific: the same key gives different passwords per region.
        self.assertNotEqual(index.smtp_password("k", "us-east-2"), index.smtp_password("k", "us-west-2"))

    def test_first_rotation_creates_a_key_and_the_derived_password(self):
        sm = FakeSecrets({**BASE, "DONOR_SMTP_USERNAME": "", "DONOR_SMTP_PASSWORD": "", "placeholder": "zz"})
        iam = FakeIam([])
        ecs = FakeEcs([])
        logins = rotate(sm, iam, ecs)
        current = json.loads(sm.get_secret_value("arn", VersionStage="AWSCURRENT")["SecretString"])
        self.assertEqual(current["DONOR_SMTP_USERNAME"], "AKIANEW1")
        self.assertEqual(current["DONOR_SMTP_PASSWORD"], doc_pseudocode("secret-AKIANEW1", REGION))
        for k, v in BASE.items():
            self.assertEqual(current[k], v)
        self.assertNotIn("placeholder", current)
        # The SMTP login was attempted with exactly the new credentials.
        self.assertEqual(logins, [(BASE["DONOR_SMTP_HOST"], 587, "AKIANEW1", current["DONOR_SMTP_PASSWORD"])])
        self.assertEqual(sm.stages["v-new"], ["AWSCURRENT"])
        self.assertEqual(sm.stages["v-current"], [])

    def test_keeps_the_previous_key_until_the_next_rotation(self):
        sm = FakeSecrets({**BASE, "DONOR_SMTP_USERNAME": "", "DONOR_SMTP_PASSWORD": ""})
        iam = FakeIam([])
        rotate(sm, iam, FakeEcs([]), token="v1")
        rotate(sm, iam, FakeEcs([]), token="v2")
        # After rotation 2: key 1 (still held by running tasks) survives, nothing deleted.
        self.assertEqual(iam.keys, ["AKIANEW1", "AKIANEW2"])
        self.assertEqual(iam.deleted, [])
        rotate(sm, iam, FakeEcs([]), token="v3")
        # Rotation 3 deletes key 1 (two rotations old) and keeps key 2 (the one in use).
        self.assertEqual(iam.deleted, ["AKIANEW1"])
        self.assertEqual(iam.keys, ["AKIANEW2", "AKIANEW3"])

    def test_removes_a_key_orphaned_by_a_failed_rotation(self):
        sm = FakeSecrets({**BASE, "DONOR_SMTP_USERNAME": "AKIAINUSE", "DONOR_SMTP_PASSWORD": "p"})
        iam = FakeIam(["AKIAINUSE", "AKIAORPHAN"])
        rotate(sm, iam, FakeEcs([]))
        self.assertEqual(iam.deleted, ["AKIAORPHAN"])
        self.assertIn("AKIAINUSE", iam.keys)

    def test_a_retried_create_does_not_mint_a_second_key(self):
        sm = FakeSecrets({**BASE, "DONOR_SMTP_USERNAME": "", "DONOR_SMTP_PASSWORD": ""})
        iam = FakeIam([])
        sm.stage("v-new")
        event = {"SecretId": "arn", "ClientRequestToken": "v-new", "Step": "createSecret"}
        index.handler(event, None, sm=sm, iam=iam, ecs=FakeEcs([]))
        index.handler(event, None, sm=sm, iam=iam, ecs=FakeEcs([]))
        self.assertEqual(iam.created, 1)

    def test_a_failed_login_fails_the_rotation_and_leaves_current_untouched(self):
        sm = FakeSecrets({**BASE, "DONOR_SMTP_USERNAME": "AKIAOLD", "DONOR_SMTP_PASSWORD": "old"})
        iam = FakeIam(["AKIAOLD"])
        sleeps = []

        def refuse(*a):
            raise RuntimeError("535 Authentication Credentials Invalid")

        with self.assertRaisesRegex(RuntimeError, "SMTP login with the new credentials failed: 535"):
            rotate(sm, iam, FakeEcs([]), login=refuse, sleep=sleeps.append)
        current = json.loads(sm.get_secret_value("arn", VersionStage="AWSCURRENT")["SecretString"])
        self.assertEqual(current["DONOR_SMTP_USERNAME"], "AKIAOLD")
        self.assertEqual(len(sleeps), 11)  # 12 attempts, 10 s apart

    def test_login_retries_while_the_new_key_propagates(self):
        sm = FakeSecrets({**BASE, "DONOR_SMTP_USERNAME": "", "DONOR_SMTP_PASSWORD": ""})
        attempts = []

        def flaky(*a):
            attempts.append(a)
            if len(attempts) < 3:
                raise RuntimeError("535")

        rotate(sm, FakeIam([]), FakeEcs([]), login=flaky)
        self.assertEqual(len(attempts), 3)

    def test_restarts_only_running_mail_workers_after_promotion(self):
        sm = FakeSecrets({**BASE, "DONOR_SMTP_USERNAME": "", "DONOR_SMTP_PASSWORD": ""})
        ecs = FakeEcs([
            {"serviceName": "login-email-worker", "status": "ACTIVE", "desiredCount": 1},
            {"serviceName": "email-change-worker", "status": "ACTIVE", "desiredCount": 0},
            {"serviceName": "api", "status": "ACTIVE", "desiredCount": 2},
        ])
        rotate(sm, FakeIam([]), ecs)
        self.assertEqual(ecs.updated, [("dad-staging", "login-email-worker", True)])

    def test_first_deploy_with_no_services_yet_still_finishes(self):
        sm = FakeSecrets({**BASE, "DONOR_SMTP_USERNAME": "", "DONOR_SMTP_PASSWORD": ""})
        ecs = FakeEcs([])
        rotate(sm, FakeIam([]), ecs)
        self.assertEqual(ecs.updated, [])
        self.assertEqual(sm.stages["v-new"], ["AWSCURRENT"])

    def test_first_rotation_before_the_cluster_exists_still_succeeds(self):
        sm = FakeSecrets({**BASE, "DONOR_SMTP_USERNAME": "", "DONOR_SMTP_PASSWORD": ""})
        ecs = FakeEcs([], cluster_exists=False)
        rotate(sm, FakeIam([]), ecs)  # must not raise
        self.assertEqual(sm.stages["v-new"], ["AWSCURRENT"])
        self.assertEqual(ecs.updated, [])

    def test_a_retried_finish_after_promotion_still_restarts_the_workers(self):
        sm = FakeSecrets({**BASE, "DONOR_SMTP_USERNAME": "", "DONOR_SMTP_PASSWORD": ""})
        ecs = FakeEcs([{"serviceName": "login-email-worker", "status": "ACTIVE", "desiredCount": 1}])
        rotate(sm, FakeIam([]), ecs)
        ecs.updated.clear()
        index.handler({"SecretId": "arn", "ClientRequestToken": "v-new", "Step": "finishSecret"},
                      None, sm=sm, iam=FakeIam([]), ecs=ecs)
        self.assertEqual(ecs.updated, [("dad-staging", "login-email-worker", True)])

    def test_finish_without_a_current_version_omits_the_remove_argument(self):
        sm = FakeSecrets({**BASE})
        sm.stages = {}
        sm.stage("v-new")
        calls = []
        sm.update_secret_version_stage = lambda **kw: calls.append(kw)
        index._finish(sm, FakeEcs([]), "arn", "v-new", sm.stages)
        self.assertEqual(calls, [{"SecretId": "arn", "VersionStage": "AWSCURRENT", "MoveToVersionId": "v-new"}])

    def test_refuses_when_rotation_is_disabled_or_the_version_is_not_pending(self):
        sm = FakeSecrets({**BASE}, rotation_enabled=False)
        sm.stage("v-new")
        with self.assertRaisesRegex(ValueError, "rotation is not enabled"):
            index.handler({"SecretId": "arn", "ClientRequestToken": "v-new", "Step": "createSecret"},
                          None, sm=sm, iam=FakeIam([]), ecs=FakeEcs([]))
        sm = FakeSecrets({**BASE})
        sm.stages["v-odd"] = ["SOMETHING"]
        with self.assertRaisesRegex(ValueError, "not AWSPENDING"):
            index.handler({"SecretId": "arn", "ClientRequestToken": "v-odd", "Step": "createSecret"},
                          None, sm=sm, iam=FakeIam([]), ecs=FakeEcs([]))


if __name__ == "__main__":
    unittest.main()
