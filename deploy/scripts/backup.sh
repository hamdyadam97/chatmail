#!/usr/bin/env bash
# Nightly backup (run by correspondence-backup.timer as root).
#
# Produces /var/backups/correspondence/<stamp>/{db.dump, blobs.tar, SHA256SUMS}.
# The database dump is taken FIRST, then the blobs: any blob referenced by
# the dump already exists on disk, so a restore is always consistent
# (verify_integrity checks exactly this).
#
# What the backup contains: ciphertext + metadata only. Message/attachment
# keys live on users' devices, so this backup cannot reveal content (SEC-18).
# It does contain account metadata and TOTP secrets wrapped with
# AUTH_FERNET_KEY (which is NOT in the backup) — still, ship it off-site
# encrypted: set BACKUP_GPG_RECIPIENT in /etc/correspondence/backup.env.
set -euo pipefail

ROOT=/var/backups/correspondence
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
DIR="$ROOT/$STAMP"
umask 077
mkdir -p "$DIR"

pg_dump --format=custom --no-owner --no-privileges --dbname="$MIGRATE_DATABASE_URL" --file="$DIR/db.dump"
tar --create --file="$DIR/blobs.tar" --directory="$ENCRYPTED_BLOB_ROOT" .
( cd "$DIR" && sha256sum db.dump blobs.tar > SHA256SUMS )

if [ -n "${BACKUP_GPG_RECIPIENT:-}" ]; then
    for f in db.dump blobs.tar; do
        gpg --batch --yes --trust-model always --recipient "$BACKUP_GPG_RECIPIENT" --encrypt "$DIR/$f"
        rm -f "$DIR/$f"
    done
fi

find "$ROOT" -mindepth 1 -maxdepth 1 -type d -mtime +"$KEEP_DAYS" -exec rm -rf {} +
echo "backup written: $DIR"
