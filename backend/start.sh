#!/bin/sh
set -e

echo "Running database migrations..."
npm run migration:run:prod

if [ "$SEED_ON_START" = "true" ]; then
  echo "Running database seed..."
  node dist/database/seed.js
fi

echo "Starting Backend API..."
exec node dist/main.js