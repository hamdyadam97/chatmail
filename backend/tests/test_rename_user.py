"""rename_user: the account keeps everything, only the login name changes."""
import pytest
from django.core.management import call_command
from django.core.management.base import CommandError

from apps.accounts.models import User
from apps.audit.models import AuditLog

from .conftest import DEFAULT_PASSWORD, assign_role, login

pytestmark = pytest.mark.django_db


def test_rename_keeps_account_roles_and_password(api_client, user_factory):
    user = user_factory("it.admin")
    assign_role(user, "sys_admin")
    call_command("rename_user", "it.admin", "hamdy.adam")  # dry run
    assert User.objects.filter(username="it.admin").exists()

    call_command("rename_user", "it.admin", "hamdy.adam", "--apply")
    renamed = User.objects.get(id=user.id)
    assert renamed.username == "hamdy.adam" and not User.objects.filter(username="it.admin").exists()
    assert login(api_client, "hamdy.adam", DEFAULT_PASSWORD).status_code == 200
    assert login(api_client, "it.admin", DEFAULT_PASSWORD).status_code == 401
    from apps.authorization.services import system_admin
    assert system_admin() == renamed
    assert AuditLog.objects.filter(action="username_changed").count() == 1


def test_rename_refuses_a_taken_or_bad_name(user_factory):
    user_factory("it.admin")
    user_factory("hamdy.adam")
    with pytest.raises(CommandError):
        call_command("rename_user", "it.admin", "Hamdy.Adam", "--apply")
    with pytest.raises(CommandError):
        call_command("rename_user", "it.admin", "حمدي", "--apply")
    with pytest.raises(CommandError):
        call_command("rename_user", "nobody", "x.y", "--apply")
