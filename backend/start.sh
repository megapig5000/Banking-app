#!/bin/sh
echo "Starting Backend API..."
# Khởi động app ở background
node dist/main.js &
APP_PID=$!

if [ "$SEED_ON_START" = "true" ]; then
  echo "Đợi 5 giây để TypeORM synchronize database..."
  sleep 5
  echo "Chạy Seed script..."
  node dist/database/seed.js
fi

# Giữ container tiếp tục chạy
wait $APP_PID