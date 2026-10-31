"""Correspondence flow: compose/send, server-side drafts, reply, forward,
folders and content search — content sealed at rest, opened for participants."""
import uuid

import pytest

from apps.correspondence.models import Correspondence, CorrespondenceParticipant
from apps.messaging.models import Conversation, Message

from .correspondence_utils import (  # noqa: F401  (fixtures)
    CONV_URL,
    CORR_URL,
    _blob_root,
    auth,
    compose,
    forward,
    make_employee,
    office,
    prepare_and_send,
    reply,
)

pytestmark = pytest.mark.django_db


def _get(api_client, h, corr_id):
    return api_client.get(f"{CORR_URL}{corr_id}/", **h)


def _folder(api_client, h, folder, q=""):
    r = api_client.get(f"{CORR_URL}?folder={folder}&q={q}", **h)
    assert r.status_code == 200, r.content
    return r.json()["results"]


def test_send_seals_content_and_delivers_it_to_recipients(api_client, office):
    sent = prepare_and_send(api_client, office["h_s"], [office["r1"]], [office["r2"]],
                            subject="تقرير الموازنة", body="مرفق التقرير السنوي")
    assert sent["status"] == "sent" and sent["reference_number"].startswith("AHL-RYD-")
    assert sent["content"]["subject"] == "تقرير الموازنة"
    stored = bytes(Message.objects.get(conversation_id=sent["thread_id"]).content_enc)
    assert "الموازنة".encode() not in stored and stored.startswith(b"v1")
    row = Correspondence.objects.get(id=sent["id"])
    assert row.draft_enc is None and row.content_message_id
    for h in (office["h_r1"], office["h_r2"]):
        detail = _get(api_client, h, sent["id"]).json()
        assert detail["content"]["body"] == "مرفق التقرير السنوي"
    inbox = _folder(api_client, office["h_r1"], "inbox")
    assert inbox[0]["subject"] == "تقرير الموازنة" and inbox[0]["preview"].startswith("مرفق")
    assert _get(api_client, office["h_o"], sent["id"]).status_code == 403


def test_compose_is_idempotent_on_client_ref(api_client, office):
    ref = uuid.uuid4()
    first = compose(api_client, office["h_s"], [office["r1"]], client_ref=ref)
    again = compose(api_client, office["h_s"], [office["r1"]], client_ref=ref)
    assert first.status_code == 201 and again.status_code == 200
    assert first.json()["id"] == again.json()["id"]
    assert Correspondence.objects.filter(sender=office["s"]).count() == 1


@pytest.mark.parametrize("case", ["self", "unknown", "duplicate"])
def test_send_rejects_bad_recipients(api_client, office, case):
    to, cc = [office["r1"]], []
    if case == "self":
        to = [office["s"]]
    elif case == "duplicate":
        cc = [office["r1"]]
    data = {}
    if case == "unknown":
        data = {"to_user_ids": [str(uuid.uuid4())]}
    r = compose(api_client, office["h_s"], to, cc, **data)
    assert r.status_code == 400


def test_bcc_is_disabled_by_default(api_client, office):
    r = compose(api_client, office["h_s"], [office["r1"]], bcc_user_ids=[str(office["r2"].id)])
    assert r.status_code == 400


def test_send_requires_correspondence_send_permission(api_client, user_factory, branch_a, office):
    user_factory("no_role", membership_unit=branch_a)
    r = compose(api_client, auth(api_client, "no_role"), [office["r1"]])
    assert r.status_code == 403


def test_draft_lives_on_the_server_and_follows_the_user(api_client, office):
    draft = compose(api_client, office["h_s"], [], send=False, subject="مسودة", body="أولى")
    assert draft.status_code == 201, draft.content
    d = draft.json()
    assert d["status"] == "draft" and d["reference_number"] is None
    row = Correspondence.objects.get(id=d["id"])
    assert "مسودة".encode() not in bytes(row.draft_enc)
    # another login of the same user sees and edits it
    other_session = auth(api_client, "c_sender")
    assert [x["id"] for x in _folder(api_client, other_session, "drafts")] == [d["id"]]
    edited = api_client.patch(f"{CORR_URL}{d['id']}/", {
        "to_user_ids": [str(office["r1"].id)], "subject": "مسودة معدلة", "body": "ثانية",
    }, format="json", **other_session)
    assert edited.status_code == 200 and edited.json()["content"]["subject"] == "مسودة معدلة"
    # recipients see nothing until it is sent
    assert _get(api_client, office["h_r1"], d["id"]).status_code == 403
    sent = api_client.post(f"{CORR_URL}{d['id']}/send/", **office["h_s"])
    assert sent.status_code == 200 and sent.json()["status"] == "sent"
    assert _get(api_client, office["h_r1"], d["id"]).json()["content"]["body"] == "ثانية"
    assert _folder(api_client, office["h_s"], "drafts") == []


def test_draft_without_recipient_cannot_be_sent(api_client, office):
    d = compose(api_client, office["h_s"], [], send=False, subject="x").json()
    assert api_client.post(f"{CORR_URL}{d['id']}/send/", **office["h_s"]).status_code == 400


def test_sent_correspondence_is_immutable(api_client, office):
    sent = prepare_and_send(api_client, office["h_s"], [office["r1"]])
    r = api_client.patch(f"{CORR_URL}{sent['id']}/", {"subject": "تعديل"}, format="json", **office["h_s"])
    assert r.status_code == 409
    assert api_client.delete(f"{CORR_URL}{sent['id']}/", **office["h_s"]).status_code == 409


def test_only_sender_edits_or_sends_a_draft(api_client, office):
    d = compose(api_client, office["h_s"], [office["r1"]], send=False).json()
    assert api_client.post(f"{CORR_URL}{d['id']}/send/", **office["h_r1"]).status_code == 403


def test_thread_content_only_enters_through_send(api_client, office):
    sent = prepare_and_send(api_client, office["h_s"], [office["r1"]])
    r = api_client.post(f"{CONV_URL}{sent['thread_id']}/messages/",
                        {"text": "خارج المسار", "client_msg_id": str(uuid.uuid4())}, format="json",
                        **office["h_s"])
    assert r.status_code == 403
    r = api_client.post(f"{CONV_URL}{sent['thread_id']}/members/", {"user_ids": [str(office["o"].id)]},
                        format="json", **office["h_s"])
    assert r.status_code == 403


def test_discard_draft_removes_thread(api_client, office):
    d = compose(api_client, office["h_s"], [office["r1"]], send=False).json()
    assert api_client.delete(f"{CORR_URL}{d['id']}/", **office["h_s"]).status_code == 204
    assert not Correspondence.objects.filter(id=d["id"]).exists()
    assert not Conversation.objects.filter(id=d["thread_id"]).exists()


def test_reference_numbers_are_sequential_per_institute(api_client, office, user_factory, branch_b):
    first = prepare_and_send(api_client, office["h_s"], [office["r1"]])
    second = prepare_and_send(api_client, office["h_s"], [office["r1"]])
    assert int(second["reference_number"][-6:]) == int(first["reference_number"][-6:]) + 1
    make_employee(user_factory, "faw_sender", branch_b)
    other = prepare_and_send(api_client, auth(api_client, "faw_sender"), [office["r1"]])
    assert other["reference_number"].startswith("FAW-") and other["reference_number"].endswith("000001")


def test_reply_stays_in_thread_and_addresses_original_sender(api_client, office):
    root = prepare_and_send(api_client, office["h_s"], [office["r1"]], [office["r2"]], subject="طلب")
    r = reply(api_client, office["h_r1"], root["id"], subject="رد: طلب", body="تم")
    assert r.status_code == 201, r.content
    rep = r.json()
    assert rep["thread_id"] == root["thread_id"] and rep["reply_to_id"] == root["id"]
    kinds = {(p["user"]["id"], p["kind"]) for p in rep["participants"]}
    assert kinds == {(str(office["s"].id), "to"), (str(office["r2"].id), "cc")}
    detail = _get(api_client, office["h_s"], root["id"]).json()
    bodies = [i["body"] for i in detail["thread_items"]]
    assert bodies == ["نص المراسلة", "تم"]


def test_outsider_cannot_reply_and_closed_refuses(api_client, office):
    root = prepare_and_send(api_client, office["h_s"], [office["r1"]])
    assert reply(api_client, office["h_o"], root["id"]).status_code == 403
    api_client.post(f"{CORR_URL}{root['id']}/close/", **office["h_s"])
    assert reply(api_client, office["h_r1"], root["id"]).status_code == 400


def test_forward_opens_new_thread_carrying_the_source_content(api_client, office):
    root = prepare_and_send(api_client, office["h_s"], [office["r1"]], subject="أصل", body="نص الأصل")
    r = forward(api_client, office["h_r1"], root["id"], [office["o"]], body="للاطلاع")
    assert r.status_code == 201, r.content
    fwd = r.json()
    assert fwd["thread_id"] != root["thread_id"] and fwd["is_forward"]
    seen = _get(api_client, office["h_o"], fwd["id"]).json()
    assert seen["content"]["forwarded"]["body"] == "نص الأصل"
    assert seen["content"]["forwarded"]["reference_number"] == root["reference_number"]
    assert seen["forwarded_from_reference"] == root["reference_number"]
    assert _get(api_client, office["h_o"], root["id"]).status_code == 403
    assert forward(api_client, office["h_o"], root["id"], [office["r2"]]).status_code == 403


def test_folder_flags_are_per_user(api_client, office):
    sent = prepare_and_send(api_client, office["h_s"], [office["r1"]], [office["r2"]])
    api_client.post(f"{CORR_URL}{sent['id']}/flags/", {"archived": True}, format="json", **office["h_r1"])
    assert _folder(api_client, office["h_r1"], "inbox") == []
    assert len(_folder(api_client, office["h_r1"], "archived")) == 1
    assert len(_folder(api_client, office["h_r2"], "inbox")) == 1


def test_search_matches_content_reference_and_arabic_variants(api_client, office):
    prepare_and_send(api_client, office["h_s"], [office["r1"]], subject="الموازنة السنوية", body="إعداد الميزانية")
    other = prepare_and_send(api_client, office["h_s"], [office["r1"]], subject="إجازة", body="طلب")
    assert [x["subject"] for x in _folder(api_client, office["h_r1"], "inbox", "موازنه")] == ["الموازنة السنوية"]
    assert [x["subject"] for x in _folder(api_client, office["h_r1"], "inbox", "اعداد الميزانيه")] == [
        "الموازنة السنوية"]
    assert [x["id"] for x in _folder(api_client, office["h_r1"], "inbox", other["reference_number"])] == [other["id"]]
    assert _folder(api_client, office["h_o"], "inbox", "الموازنة") == []


def test_unknown_folder_is_rejected(api_client, office):
    assert api_client.get(f"{CORR_URL}?folder=nope", **office["h_s"]).status_code == 400


def test_thread_items_carry_my_unread_flag_only(api_client, office):
    root = prepare_and_send(api_client, office["h_s"], [office["r1"]], [office["r2"]])
    items = _get(api_client, office["h_r1"], root["id"]).json()["thread_items"]
    assert [i["unread"] for i in items] == [True]
    api_client.post(f"{CORR_URL}{root['id']}/read/", **office["h_r1"])
    assert [i["unread"] for i in _get(api_client, office["h_r1"], root["id"]).json()["thread_items"]] == [False]
    assert CorrespondenceParticipant.objects.get(correspondence_id=root["id"], user=office["r2"]).read_at is None


def test_list_rows_carry_whole_conversation_stats(api_client, office):
    root = prepare_and_send(api_client, office["h_s"], [office["r1"]])
    reply(api_client, office["h_r1"], root["id"])
    [row] = [r for r in _folder(api_client, office["h_s"], "sent") if r["id"] == root["id"]]
    assert row["thread_count"] == 2
