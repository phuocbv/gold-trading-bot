# Sử dụng Node.js 22 LTS Alpine nhẹ và bảo mật
FROM node:22-alpine AS base

# Cài đặt múi giờ Việt Nam (Asia/Ho_Chi_Minh)
RUN apk add --no-cache tzdata
ENV TZ=Asia/Ho_Chi_Minh

WORKDIR /app

# Copy package files
COPY package.json pnpm-lock.yaml* ./

# Cài đặt pnpm và dependencies
RUN npm install -g pnpm && \
    pnpm install --frozen-lockfile --prod

# Copy toàn bộ mã nguồn
COPY . .

# Expose port cho dummy web server (nếu deploy Render/PaaS)
EXPOSE 3000

# Chạy bot
CMD ["node", "bot.js"]
