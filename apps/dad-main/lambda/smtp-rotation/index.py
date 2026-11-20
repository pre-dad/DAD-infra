"""Secrets Manager rotation for the SES SMTP credentials (dad/<env>/ses/smtp).

The secret is JSON: DONOR_SMTP_HOST, DONOR_SMTP_PORT, DONOR_EMAIL_FROM,
DONOR_SMTP_USERNAME (an IAM access key id) and DONOR_SMTP_PASSWORD (the SES SMTP
password derived from that key's secret). Each rotation creates a new access key for the
SMTP IAM user, stores its derived password, proves it with a real SMTP login, promotes
it, and restarts the mail workers so they pick it up.

The previous key is NOT deleted when a rotation finishes: tasks started before it still
hold the old password until they restart. It is deleted at the start of the NEXT rotation,
which keeps the user at IAM's limit of two keys.

Environment:
  SMTP_USER_NAME   the IAM user whose keys are rotated
  SES_REGION       region the SMTP password is derived for
  CLUSTER_NAME     ECS cluster of the mail workers (optional)
  MAIL_SERVICES    comma-separated services to restart after a rotation (optional)
"""

import base64
import hashlib
import hmac
import json
import os
import smtplib
import ssl
import time

# Fixed inputs of AWS's documented SES SMTP password algorithm.
_SMTP_DATE = "11111111"
_SMTP_SERVICE = "ses"
_SMTP_TERMINAL = "aws4_request"
_SMTP_MESSAGE = "SendRawEmail"
_SMTP_VERSION = 0x04

_CURRENT = "AWSCURRENT"
_PENDING = "AWSPENDING"


def smtp_password(secret_access_key: str, region: str) -> str:
    """Derive the SES SMTP password from an IAM secret access key, per AWS's algorithm."""

    def sign(key: bytes, msg: str) -> bytes:
        return hmac.new(key, msg.encode("utf-8"), hashlib.sha256).digest()

    signature = sign(("AWS4" + secret_access_key).encode("utf-8"), _SMTP_DATE)
    for part in (region, _SMTP_SERVICE, _SMTP_TERMINAL, _SMTP_MESSAGE):
        signature = sign(signature, part)
    return base64.b64encode(bytes([_SMTP_VERSION]) + signature).decode("ascii")


def default_smtp_login(host: str, port: int, username: str, password: str) -> None:
    """Authenticate to the SES SMTP endpoint with STARTTLS; raise if it is refused."""
    with smtplib.SMTP(host, port, timeout=15) as smtp:
        smtp.starttls(context=ssl.create_default_context())
        smtp.login(username, password)


def handler(event, context, sm=None, iam=None, ecs=None, smtp_login=None, sleep=time.sleep):
    if sm is None or iam is None or ecs is None:
        import boto3  # Only in Lambda; the unit tests inject fakes.

        sm = sm or boto3.client("secretsmanager")
        iam = iam or boto3.client("iam")
        ecs = ecs or boto3.client("ecs")
    smtp_login = smtp_login or default_smtp_login

    arn = event["SecretId"]
    token = event["ClientRequestToken"]
    step = event["Step"]

    meta = sm.describe_secret(SecretId=arn)
    if not meta.get("RotationEnabled"):
        raise ValueError(f"rotation is not enabled for {arn}")
    versions = meta.get("VersionIdsToStages", {})
    if token not in versions:
        raise ValueError(f"version {token} is not staged for rotation of {arn}")
    if _CURRENT in versions[token]:
        if step == "finishSecret":
            # A retry after the stage moved but the restart failed: restart again.
            _restart_mail_workers(ecs)
        return
    if _PENDING not in versions[token]:
        raise ValueError(f"version {token} is not AWSPENDING for {arn}")

    if step == "createSecret":
        _create(sm, iam, arn, token)
    elif step == "setSecret":
        pass  # The key is live in IAM as soon as it is created.
    elif step == "testSecret":
        _test(sm, arn, token, smtp_login, sleep)
    elif step == "finishSecret":
        _finish(sm, ecs, arn, token, versions)
    else:
        raise ValueError(f"unknown rotation step {step}")


def _secret(sm, arn, **version):
    return json.loads(sm.get_secret_value(SecretId=arn, **version)["SecretString"])


def _create(sm, iam, arn, token):
    # Idempotent: a retried createSecret must not mint a second key.
    try:
        sm.get_secret_value(SecretId=arn, VersionId=token, VersionStage=_PENDING)
        return
    except sm.exceptions.ResourceNotFoundException:
        pass

    current = _secret(sm, arn, VersionStage=_CURRENT)
    user = os.environ["SMTP_USER_NAME"]
    keep = current.get("DONOR_SMTP_USERNAME", "")

    # Delete every key except the one in use: the previous rotation's key, or one left
    # behind by a rotation that failed after creating it.
    for key in iam.list_access_keys(UserName=user)["AccessKeyMetadata"]:
        if key["AccessKeyId"] != keep:
            iam.delete_access_key(UserName=user, AccessKeyId=key["AccessKeyId"])

    new = iam.create_access_key(UserName=user)["AccessKey"]
    pending = dict(current)
    pending["DONOR_SMTP_USERNAME"] = new["AccessKeyId"]
    pending["DONOR_SMTP_PASSWORD"] = smtp_password(new["SecretAccessKey"], os.environ["SES_REGION"])
    pending.pop("placeholder", None)
    sm.put_secret_value(
        SecretId=arn,
        ClientRequestToken=token,
        SecretString=json.dumps(pending),
        VersionStages=[_PENDING],
    )


def _test(sm, arn, token, smtp_login, sleep, attempts=12, delay=10):
    pending = _secret(sm, arn, VersionId=token, VersionStage=_PENDING)
    last = None
    # A new IAM key can take a little while to be accepted by SES.
    for attempt in range(attempts):
        try:
            smtp_login(
                pending["DONOR_SMTP_HOST"],
                int(pending["DONOR_SMTP_PORT"]),
                pending["DONOR_SMTP_USERNAME"],
                pending["DONOR_SMTP_PASSWORD"],
            )
            return
        except Exception as error:  # noqa: BLE001 - report the last failure below
            last = error
            if attempt < attempts - 1:
                sleep(delay)
    raise RuntimeError(f"SMTP login with the new credentials failed: {last}")


def _finish(sm, ecs, arn, token, versions):
    current_version = next((v for v, stages in versions.items() if _CURRENT in stages), None)
    move = {"SecretId": arn, "VersionStage": _CURRENT, "MoveToVersionId": token}
    if current_version is not None:
        move["RemoveFromVersionId"] = current_version
    sm.update_secret_version_stage(**move)
    _restart_mail_workers(ecs)


def _restart_mail_workers(ecs):
    """Make running mail workers re-read the secret. ECS injects it only at task start."""
    cluster = os.environ.get("CLUSTER_NAME", "")
    services = [s for s in os.environ.get("MAIL_SERVICES", "").split(",") if s]
    if not cluster or not services:
        return
    try:
        found = ecs.describe_services(cluster=cluster, services=services).get("services", [])
    except ecs.exceptions.ClusterNotFoundException:
        # First deploy: the SES stack (and its first rotation) comes before the cluster.
        # The secret is already promoted; there is simply nothing running to restart.
        return
    for service in found:
        # Skip workers that are switched off; missing services (first deploy) are
        # simply absent from the response.
        if service.get("status") == "ACTIVE" and service.get("desiredCount", 0) > 0:
            ecs.update_service(
                cluster=cluster, service=service["serviceName"], forceNewDeployment=True
            )
