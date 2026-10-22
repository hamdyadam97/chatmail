"""bootstrap_admin: first administrator on a fresh install."""
import re

import pytest
from django.core.management import CommandError, call_command

from apps.accounts.models import TrustedDevice, User
from apps.audit.models import AuditLog
from apps.authorization.services import has_permission

pytestmark = pytest.mark.django_db


def test_creates_central_admin_with_one_time_password(capsys, api_client):
    call_command("bootstrap_admin", "--username", "it.admin", "--first-name", "محمد",
                 "--institute", "AHL", "--role", "sys_admin")
    out = capsys.readouterr().out
    temp = re.search(r"temporary password .*: (\S+)", out).group(1)
    user = User.objects.get(username="it.admin")
    assert user.must_change_password and user.check_password(temp)
    assert has_permission(user, "accounts.manage_users", unit=None)
    assert not TrustedDevice.objects.filter(user=user).exists()  # no crypto touched
    row = AuditLog.objects.get(action="account_bootstrapped")
    assert temp not in repr(row.metadata)
    resp = api_client.post("/api/v1/auth/login/", {"username": "it.admin", "password": temp}, format="json")
    assert resp.status_code == 200


def test_refuses_combined_duties_unless_explicit():
    with pytest.raises(CommandError, match="separation of duties"):
        call_command("bootstrap_admin", "--username", "a1", "--institute", "AHL",
                     "--role", "sys_admin", "--role", "hr_admin")
    call_command("bootstrap_admin", "--username", "a2", "--institute", "AHL",
                 "--role", "sys_admin", "--role", "hr_admin", "--allow-combined-duties")
    assert User.objects.filter(username="a2").exists()


@pytest.mark.parametrize("args", [
    ["--institute", "NOPE", "--role", "sys_admin"],
    ["--institute", "AHL", "--role", "no_such_role"],
    ["--institute", "AHL", "--branch", "NOPE", "--role", "sys_admin"],
])
def test_validates_inputs(args):
    with pytest.raises(CommandError):
        call_command("bootstrap_admin", "--username", "bad", *args)
    assert not User.objects.filter(username="bad").exists()
