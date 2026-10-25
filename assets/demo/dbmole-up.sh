#!/usr/bin/env bash
# Throwaway demo database for the README GIF (assets/dbmole-demo.tape). Needs Docker.
#   assets/demo/dbmole-up.sh        start PostgreSQL on 127.0.0.1:55432 (shop/reporter/demo)
#   assets/demo/dbmole-up.sh down   remove the container
set -euo pipefail
cd "$(dirname "$0")"

if [ "${1:-}" = down ]; then
    docker rm -f mole-demo-pg
    exit
fi

docker run -d --name mole-demo-pg -p 127.0.0.1:55432:5432 \
    -e POSTGRES_PASSWORD=demo -e POSTGRES_DB=shop \
    -v "$PWD/shop.sql:/docker-entrypoint-initdb.d/shop.sql:ro" postgres:17-alpine
echo 'waiting for postgres...'
until docker exec mole-demo-pg pg_isready -U reporter -d shop -h 127.0.0.1 > /dev/null 2>&1; do
    sleep 2
done
echo 'demo database ready'
