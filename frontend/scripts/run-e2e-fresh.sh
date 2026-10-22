#!/bin/sh
# run-e2e-fresh.sh — يشغّل سكربت إثبات e2e على قاعدة بيانات مؤقتة جديدة.
#
# لماذا: سكربتات e2e تولّد هويات تشفير جديدة لحسابات seed_demo في كل تشغيل؛
# على قاعدة سبق استخدامها تكون الهوية موجودة ومفتاحها الخاص ضاع مع التشغيل
# السابق، فيرفض الخادم (بحق) اعتماد الجهاز الجديد دون جهاز موثّق. لذا كل تشغيل
# يحتاج قاعدة نظيفة — ولا نلمس قاعدة التطوير backend/db.sqlite3.
#
# الاستخدام (من جذر المستودع):
#   sh frontend/scripts/run-e2e-fresh.sh e2e-correspondence.mjs [port]
#
# المنفذ الافتراضي 8001 حتى لا يتعارض مع خادم التطوير على 8000.
set -u
SCRIPT="${1:?usage: run-e2e-fresh.sh <script.mjs> [port]}"
PORT="${2:-8001}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WORK="$(mktemp -d)"
# Git Bash: مسار /tmp لا يفهمه Python الأصلي على ويندوز.
command -v cygpath >/dev/null 2>&1 && WORK="$(cygpath -m "$WORK")"
PY="$ROOT/.venv/Scripts/python.exe"
[ -x "$PY" ] || PY="$ROOT/.venv/bin/python"

stop_server() {
  # venv python على ويندوز مُطلِق يشغّل عملية ابن؛ نوقف كل ما يطابق المنفذ.
  if command -v powershell >/dev/null 2>&1; then
    powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='python.exe'\" | Where-Object { \$_.CommandLine -like '*runserver $PORT *' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force }" >/dev/null 2>&1
  else
    pkill -f "runserver $PORT " >/dev/null 2>&1
  fi
}

export DATABASE_URL="sqlite:///$WORK/e2e.sqlite3"
export ENCRYPTED_BLOB_ROOT="$WORK/blobs"
"$PY" "$ROOT/backend/manage.py" migrate -v0 >/dev/null 2>&1 || { echo "migrate failed"; exit 2; }
"$PY" "$ROOT/backend/manage.py" seed_demo >/dev/null 2>&1 || { echo "seed_demo failed"; exit 2; }
"$PY" "$ROOT/backend/manage.py" runserver "$PORT" --noreload >"$WORK/server.log" 2>&1 &

ready=""
for _ in $(seq 1 60); do
  code=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:$PORT/api/v1/correspondences/")
  [ "$code" = "401" ] && ready=1 && break
  sleep 1
done
if [ -z "$ready" ]; then
  echo "server did not start — see $WORK/server.log"
  stop_server
  exit 2
fi

(cd "$ROOT/frontend" && BASE_URL="http://localhost:$PORT/api/v1" node "scripts/$SCRIPT")
status=$?
stop_server
rm -rf "$WORK"
exit $status
