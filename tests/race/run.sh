#!/bin/sh
# Runs the race tests against a dedicated test database — never the dev one.
set -e
: "${TEST_DATABASE_URL:=postgresql://nutriclinic:nutriclinic_dev_pw@localhost:5433/nutriclinic_test?schema=public}"

case "$TEST_DATABASE_URL" in
  *_test\?*|*_test) ;;
  *)
    echo "Refusing to run: TEST_DATABASE_URL must point at a database named *_test." >&2
    echo "  got: $TEST_DATABASE_URL" >&2
    exit 1
    ;;
esac

export DATABASE_URL="$TEST_DATABASE_URL"
# Components rendered in these tests need a JSX runtime (see tests/race/tsconfig.json).
export TSX_TSCONFIG_PATH="tests/race/tsconfig.json"
export DIRECT_URL="$TEST_DATABASE_URL"
npx prisma migrate deploy >/dev/null

if [ -n "$1" ]; then
  exec npx tsx "$1"
fi

status=0
for t in tests/race/t*.ts; do
  echo "===== $t"
  npx tsx "$t" || status=1
done
exit $status
