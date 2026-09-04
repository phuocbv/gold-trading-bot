#!/bin/bash

# Dừng script nếu có lỗi
set -e

echo "=========================================================="
echo "🚀 AUTO DEPLOY GOLD TRADING BOT LÊN LINUX SERVER / VPS 24/7"
echo "=========================================================="

# Yêu cầu nhập thông tin VPS
read -p "🌐 Nhập địa chỉ IP của VPS / Server: " VPS_IP

if [ -z "$VPS_IP" ]; then
  echo "❌ Bạn chưa nhập IP. Thoát!"
  exit 1
fi

read -p "👤 Nhập username SSH (mặc định: 'ubuntu'): " VPS_USER
VPS_USER=${VPS_USER:-ubuntu}

read -p "🔑 Nhập đường dẫn file SSH Private Key (VD: ~/.ssh/id_rsa) - Để trống nếu dùng mặc định: " SSH_KEY

SSH_OPT=""
if [ -n "$SSH_KEY" ]; then
  # Thay thế ~ bằng đường dẫn HOME tuyệt đối nếu có
  SSH_KEY="${SSH_KEY/#\~/$HOME}"
  SSH_OPT="-i $SSH_KEY"
fi

echo ""
echo "📦 Đang đồng bộ mã nguồn lên VPS (loại bỏ node_modules để tiết kiệm băng thông)..."
rsync -avz --exclude 'node_modules' --exclude '.git' -e "ssh -o StrictHostKeyChecking=no $SSH_OPT" ./ $VPS_USER@$VPS_IP:~/gold-trading-bot/

echo ""
echo "⚙️ Đang kết nối vào VPS để cài đặt môi trường (Node.js, pnpm, pm2) và khởi chạy Bot..."

# Gửi lệnh trực tiếp vào VPS qua SSH
ssh -o StrictHostKeyChecking=no $SSH_OPT $VPS_USER@$VPS_IP << 'EOF'
  set -e

  echo "🔄 Đang kiểm tra Node.js..."
  if ! command -v node &> /dev/null; then
    echo "⬇️ Chưa có Node.js. Đang cài đặt Node.js v22..."
    sudo apt-get update
    curl -fsSL https://deb.nodesource.com/setup_22.x -o nodesource_setup.sh
    sudo -E bash nodesource_setup.sh
    sudo apt-get install -y nodejs
  else
    echo "✅ Node.js đã được cài đặt: $(node -v)"
  fi

  echo "🛠 Đang cài đặt pnpm và pm2..."
  sudo npm install -g pnpm pm2

  echo "📂 Di chuyển vào thư mục dự án..."
  cd ~/gold-trading-bot

  echo "📦 Đang cài đặt thư viện phụ thuộc..."
  pnpm install

  echo "🚀 Khởi động Bot bằng PM2..."
  mkdir -p logs
  pm2 delete "gold-trading-bot" 2>/dev/null || pm2 delete "gold-bot" 2>/dev/null || true
  pm2 start ecosystem.config.js

  echo "💾 Lưu cấu hình PM2 để tự khởi động cùng hệ thống khi reboot..."
  pm2 save
  
  # Cài đặt lệnh tự bật PM2 khi VPS restart (nếu chưa bật)
  sudo env PATH=$PATH:/usr/bin $(which pm2) startup systemd -u $USER --hp $HOME || true

  echo "=========================================================="
  echo "✅ BOT ĐÃ HOẠT ĐỘNG THÀNH CÔNG 24/7!"
  echo "=========================================================="
EOF

echo ""
echo "🎉 DEPLOY HOÀN TẤT!"
echo "👉 Để xem log trên VPS, bạn có thể kết nối vào máy chủ và gõ: pm2 logs gold-bot"
