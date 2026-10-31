"""Post-deploy / post-restore integrity verification (phase 6: backup + restore tests).

    manage.py verify_integrity [--skip-blobs]

Checks (exit code 1 if any fails):
  1. migrations    — no unapplied migration (schema matches the code).
  2. content_key   — CONTENT_ENCRYPTION_KEY opens the most recent stored
                     messages and files (a restore with the wrong key would
                     otherwise look fine and lose every message).
  3. blobs         — every attachment exists in ENCRYPTED_BLOB_ROOT with the
                     recorded size and SHA-256 (DB and file backup belong
                     together).
  4. ciphertext    — every stored message is a sealed blob (nothing readable
                     slipped in — SEC-03).
  5. sequences     — every issued reference number is ≤ its counter, so new
                     numbers after a restore cannot collide with old ones.

Nothing is printed except counts and identifiers.
"""
import hashlib
import re

from django.conf import settings
from django.core.management.base import BaseCommand
from django.db import connection
from django.db.migrations.executor import MigrationExecutor


class Command(BaseCommand):
    help = "Verify database/blob integrity after a deployment or a restore."

    def add_arguments(self, parser):
        parser.add_argument("--skip-blobs", action="store_true", help="skip hashing every blob (fast run)")

    def handle(self, *args, **options):
        checks = [
            ("migrations", self._migrations),
            ("content_key", self._content_key),
            ("ciphertext", self._ciphertext),
            ("sequences", self._sequences),
        ]
        if not options["skip_blobs"]:
            checks.insert(2, ("blobs", self._blobs))
        failures = 0
        for name, fn in checks:
            try:
                ok, detail = fn()
            except Exception as exc:  # report, never crash half-way
                ok, detail = False, f"{type(exc).__name__}: {exc}"
            failures += 0 if ok else 1
            style = self.style.SUCCESS if ok else self.style.ERROR
            self.stdout.write(style(f"[{'OK' if ok else 'FAIL'}] {name}: {detail}"))
        if failures:
            self.stderr.write(self.style.ERROR(f"{failures} check(s) failed"))
            raise SystemExit(1)
        self.stdout.write(self.style.SUCCESS("all integrity checks passed"))

    # --- checks -------------------------------------------------------------------

    def _migrations(self):
        executor = MigrationExecutor(connection)
        pending = executor.migration_plan(executor.loader.graph.leaf_nodes())
        if pending:
            return False, f"{len(pending)} unapplied migration(s)"
        return True, "schema up to date"

    def _content_key(self):
        from apps import vault
        from apps.correspondence.models import StoredFile
        from apps.messaging.models import Message

        sample = 50
        messages = list(Message.objects.order_by("-created_at")[:sample])
        bad = [m.id for m in messages
               if _opens(vault, m.content_enc, "message", m.conversation_id) is False]
        files = list(StoredFile.objects.filter(meta_enc__isnull=False).order_by("-uploaded_at")[:sample])
        bad += [f.id for f in files if _opens(vault, f.meta_enc, "file-meta", f.id) is False]
        if bad:
            return False, f"{len(bad)} recent item(s) do not open with CONTENT_ENCRYPTION_KEY, first: {bad[0]}"
        return True, f"key opens {len(messages)} recent message(s) and {len(files)} file(s)"

    def _blobs(self):
        from apps.correspondence.models import StoredFile
        from apps.correspondence.services import blob_storage

        storage = blob_storage()
        bad = []
        count = 0
        for stored in StoredFile.objects.filter(deleted_at__isnull=True).iterator():
            count += 1
            if not storage.exists(stored.storage_key):
                bad.append(f"{stored.id}: missing")
                continue
            digest = hashlib.sha256()
            size = 0
            with storage.open(stored.storage_key, "rb") as fh:
                for chunk in iter(lambda: fh.read(1024 * 1024), b""):
                    digest.update(chunk)
                    size += len(chunk)
            if size != stored.ciphertext_size or digest.digest() != bytes(stored.ciphertext_sha256):
                bad.append(f"{stored.id}: size/hash mismatch")
        if bad:
            return False, f"{len(bad)}/{count} blob(s) bad, first: {bad[0]} (root: {settings.ENCRYPTED_BLOB_ROOT})"
        return True, f"{count} blob(s) present with matching SHA-256"

    def _ciphertext(self):
        from apps import vault
        from apps.messaging.models import Message

        bad = 0
        total = 0
        for blob in Message.objects.values_list("content_enc", flat=True).iterator():
            total += 1
            if not bytes(blob).startswith(vault.VERSION):
                bad += 1
        if bad:
            return False, f"{bad}/{total} stored message(s) are not sealed"
        return True, f"{total} message(s) are sealed"

    def _sequences(self):
        from apps.announcements.models import Announcement, AnnouncementSequence
        from apps.correspondence.models import Correspondence, ReferenceSequence

        issues = []
        tail = re.compile(r"-(\d{4})-(\d+)$")

        def scan(rows, counters, label):
            highest: dict[tuple, int] = {}
            for institute_id, ref in rows:
                m = tail.search(ref or "")
                if not m:
                    continue
                key = (str(institute_id), int(m.group(1)))
                highest[key] = max(highest.get(key, 0), int(m.group(2)))
            for key, top in highest.items():
                if counters.get(key, 0) < top:
                    issues.append(f"{label} {key[0]}/{key[1]}: issued {top} > counter {counters.get(key, 0)}")

        scan(
            Correspondence.objects.filter(reference_number__isnull=False).values_list(
                "sender_membership__institute_id", "reference_number"
            ),
            {(str(r.institute_id), r.year): r.last_seq for r in ReferenceSequence.objects.all()},
            "correspondence",
        )
        scan(
            Announcement.objects.filter(reference_number__isnull=False).values_list(
                "publisher_membership__institute_id", "reference_number"
            ),
            {(str(r.institute_id), r.year): r.last_seq for r in AnnouncementSequence.objects.all()},
            "announcement",
        )
        if issues:
            return False, f"{len(issues)} counter(s) behind issued numbers, first: {issues[0]}"
        return True, "reference counters ahead of every issued number"


def _opens(vault, blob, purpose, owner) -> bool:
    try:
        vault.open_(blob, purpose=purpose, owner=owner)
        return True
    except vault.VaultError:
        return False
