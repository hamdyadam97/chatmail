"""Unified search: finds content the caller may read — and nothing else."""
import pytest

from .correspondence_utils import _blob_root, office, prepare_and_send  # noqa: F401  (fixtures)
from .messaging_utils import create_conversation, post_message

pytestmark = pytest.mark.django_db
URL = "/api/v1/search/"


def _kinds(api_client, h, q, kind=""):
    r = api_client.get(URL, {"q": q, "kind": kind}, **h)
    assert r.status_code == 200, r.content
    return sorted(hit["kind"] for hit in r.json()["results"])


def test_search_spans_mail_and_chat_within_read_rights(api_client, office):
    prepare_and_send(api_client, office["h_s"], [office["r1"]], subject="خطة الموازنة", body="تفاصيل")
    conv = create_conversation(api_client, office["h_s"], "dm", [office["r1"].id]).json()["id"]
    post_message(api_client, office["h_s"], conv, "راجع الموازنه اليوم")
    assert _kinds(api_client, office["h_r1"], "الموازنة") == ["chat", "correspondence"]
    assert _kinds(api_client, office["h_r1"], "الموازنة", "chat") == ["chat"]
    assert _kinds(api_client, office["h_o"], "الموازنة") == []  # outsider sees nothing
    hit = api_client.get(URL, {"q": "خطة"}, **office["h_r1"]).json()["results"][0]
    assert hit["title"] == "خطة الموازنة" and hit["link"].startswith("/mail/")


def test_query_is_validated(api_client, office):
    assert api_client.get(URL, {"q": "م"}, **office["h_s"]).status_code == 400
    assert api_client.get(URL, {"q": "موازنة", "kind": "x"}, **office["h_s"]).status_code == 400
