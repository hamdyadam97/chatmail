"""set_temp_password: only never-logged-in accounts that must change their
password get it; the admin and active users are untouched; audited."""
import pytest
from django.core.management import call_command
from django.utils import timezone

from apps.accounts.models import User
from apps.audit.models import AuditLog

pytestmark = pytest.mark.django_db
SECRET = "Maahad@2026x"


def test_one_temporary_password_for_new_accounts_only(user_factory, monkeypatch):
    admin = user_factory("it.admin")
    new = user_factory("new.one")
    User.objects.filter(id=new.id).update(must_change_password=True)
    used = user_factory("old.hand")
    User.objects.filter(id=used.id).update(must_change_password=True, last_login_at=timezone.now())
    settled = user_factory("settled")  # never logged in but no forced change
    monkeypatch.setattr("apps.accounts.management.commands.set_temp_password.getpass", lambda _: SECRET)

    call_command("set_temp_password")
    assert not User.objects.get(id=new.id).check_password(SECRET)  # dry run

    call_command("set_temp_password", "--apply")
    assert User.objects.get(id=new.id).check_password(SECRET)
    assert User.objects.get(id=new.id).must_change_password
    for other in (admin, used, settled):
        assert not User.objects.get(id=other.id).check_password(SECRET)
    entry = AuditLog.objects.get(action="password_reset", target_id=str(new.id))
    assert SECRET not in str(entry.metadata)
