FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
# Chỉ cài đặt dependencies cần thiết cho production
RUN npm ci --omit=dev
# Copy compiled code từ builder
COPY --from=builder /app/dist ./dist
# Copy start script và chuẩn hóa LF cho môi trường Alpine Linux
COPY start.sh ./
RUN sed -i 's/\r$//' start.sh && chmod +x start.sh

EXPOSE 3000
CMD ["./start.sh"]