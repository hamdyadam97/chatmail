#!/usr/bin/env bash
# Restore test: restore a backup into a SEPARATE scratch database and blob
# directory, run verify_integrity against it, then clean up. Production is
# never touched. Run monthly (and after any backup change):
#
#   sudo /opt/correspondence/deploy/scripts/restore-test.sh [/var/backups/correspondence/<stamp>]
set -euo pipefail

ENV_FILE=/etc/correspondence/correspondence.env
set -a; . "$ENV_FILE"; . /etc/correspondence/migrate.env; set +a
APP=/opt/correspondence
SRC="${1:-$(ls -1d /var/backups/correspondence/*/ | sort | tail -1)}"
SRC="${SRC%/}"
SCRATCH_DB=correspondence_restore_test
WORK=$(mktemp -d /var/lib/correspondence/restore-test.XXXXXX)
trap 'rm -rf "$WORK"; sudo -u postgres dropdb --if-exists "$SCRATCH_DB"' EXIT

echo "== backup: $SRC"
for f in db.dump blobs.tar; do
    if [ -f "$SRC/$f.gpg" ]; then
        gpg --batch --yes --output "$WORK/$f" --decrypt "$SRC/$f.gpg"
    else
        cp "$SRC/$f" "$WORK/$f"
    fi
done
( cd "$WORK" && sha256sum --check --quiet "$SRC/SHA256SUMS" ) && echo "   checksums OK"

echo "== restore into scratch database $SCRATCH_DB"
sudo -u postgres dropdb --if-exists "$SCRATCH_DB"
sudo -u postgres createdb -O corr_owner -E UTF8 "$SCRATCH_DB"
SCRATCH_URL="${MIGRATE_DATABASE_URL%/*}/$SCRATCH_DB"
pg_restore --no-owner --no-privileges --exit-on-error --dbname="$SCRATCH_URL" "$WORK/db.dump"
mkdir -p "$WORK/blobs" && tar --extract --file="$WORK/blobs.tar" --directory="$WORK/blobs"
chown -R correspondence:correspondence "$WORK"

echo "== verify_integrity on the restored copy"
# runuser keeps the environment loaded above; only the two paths are overridden.
( cd "$APP/backend" && DATABASE_URL="$SCRATCH_URL" ENCRYPTED_BLOB_ROOT="$WORK/blobs" \
    runuser -u correspondence -- "$APP/.venv/bin/python" manage.py verify_integrity )
echo "RESTORE TEST PASSED for $SRC"
