#!/usr/bin/env bash
# =============================================
# Cập nhật Zalo Inbox lên phiên bản mới nhất từ GitHub (chạy trong thư mục cài đặt trên server)
#   bash update.sh                # cập nhật + restart PM2
#   bash update.sh --check        # chỉ xem có bản mới không
# Yêu cầu: đã cài bằng `git clone`, có .env, PM2 đang chạy app này.
# =============================================
set -Eeuo pipefail
cd "$(dirname "$0")"

if [ ! -d .git ]; then
    echo "❌ Thư mục này không phải bản cài bằng git clone. Xem SETUP.md mục Cập nhật."; exit 1
fi

current=$(node -p "require('./package.json').version" 2>/dev/null || echo "?")
git fetch --tags origin >/dev/null 2>&1 || { echo "❌ Không kết nối được GitHub"; exit 1; }
branch=$(git rev-parse --abbrev-ref HEAD)
behind=$(git rev-list --count HEAD..origin/"$branch" 2>/dev/null || echo 0)
echo "Phiên bản hiện tại: v$current — có $behind commit mới trên origin/$branch"
if [ "${1:-}" = "--check" ]; then exit 0; fi
if [ "$behind" = "0" ]; then echo "✅ Đã là bản mới nhất."; exit 0; fi

if ! git diff --quiet || ! git diff --cached --quiet; then
    echo "⚠️ Có file bị sửa tay trong thư mục cài đặt:"; git status --short | head -20
    echo "   Cập nhật sẽ dừng để không mất thay đổi. Hoàn nguyên bằng: git checkout -- . (mất sửa tay) rồi chạy lại."
    exit 1
fi

# Tên PM2 process: lấy từ ecosystem hoặc đoán theo thư mục
pm2name=$(pm2 jlist 2>/dev/null | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const cwd=process.cwd();const p=JSON.parse(d||'[]').find(x=>x.pm2_env&&x.pm2_env.pm_cwd===cwd);console.log(p?p.name:'')})" 2>/dev/null || true)

# Backup DB nhất quán trước khi cập nhật
mkdir -p backups
stamp=$(date +%Y%m%d-%H%M%S)
if [ -f data/inbox.db ]; then
    node -e "new (require('better-sqlite3'))('data/inbox.db',{readonly:true}).backup('backups/inbox-before-update-$stamp.db').then(()=>console.log('💾 Backup DB: backups/inbox-before-update-$stamp.db'))"
fi
cp -f .env "backups/env-before-update-$stamp" 2>/dev/null || true
chmod 600 backups/* 2>/dev/null || true

echo "⬇️  Lấy code mới..."
git pull --ff-only origin "$branch"
new=$(node -p "require('./package.json').version")
echo "📦 Cài dependencies (nếu có thay đổi)..."
npm install --omit=dev --no-audit --no-fund

if [ -n "$pm2name" ]; then
    echo "🔄 Khởi động lại PM2: $pm2name"
    pm2 restart "$pm2name" --update-env >/dev/null
    for i in $(seq 1 20); do sleep 1; curl -s -m 2 "http://127.0.0.1:$(grep -E '^PORT=' .env | cut -d= -f2 | tr -d ' ')/health" | grep -q running && break; done
    curl -s -m 5 "http://127.0.0.1:$(grep -E '^PORT=' .env | cut -d= -f2 | tr -d ' ')/health" || true; echo
else
    echo "ℹ️ Không tìm thấy PM2 process chạy từ thư mục này — tự khởi động lại app của bạn."
fi
echo "✅ Đã cập nhật v$current → v$new. Xem thay đổi trong CHANGELOG.md. Backup cũ nằm trong backups/ (xóa khi không cần)."
