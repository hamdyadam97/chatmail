"""Helpers for the approvals suites."""
APPROVALS_URL = "/api/v1/approvals/"


def decide(client, headers, req: dict, decision="approved"):
    return client.post(f"{APPROVALS_URL}{req['id']}/decide/", {"decision": decision}, format="json", **headers)


def request_approval(client, headers, correspondence_id, steps):
    body = {
        "correspondence_id": str(correspondence_id),
        "steps": [{"type": t, "approver_ids": [str(u.id) for u in users]} for t, users in steps],
    }
    return client.post(APPROVALS_URL, body, format="json", **headers)
