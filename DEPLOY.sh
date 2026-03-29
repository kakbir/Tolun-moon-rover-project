#!/bin/bash
# ============================================
# AY KEŞİF SİSTEMİ - Sunucu Kurulum Scripti
# CloudPanel / Ubuntu / Debian sunucu için
# ============================================

echo "🌙 Ay Keşif Sistemi - Sunucu Kurulumu"
echo "======================================"

# 1. Gerekli paketler
sudo apt update
sudo apt install -y python3 python3-pip python3-venv

# 2. Proje klasörü
cd /home/cloudpanel/htdocs
mkdir -p moon
cd moon

# 3. Dosyaları buraya kopyala (scp ile veya git ile)
# scp -r local_path/* user@sunucu:/home/cloudpanel/htdocs/moon/
# VEYA: git clone <repo_url> .

# 4. Virtual environment
python3 -m venv venv
source venv/bin/activate

# 5. Bağımlılıklar
pip install flask flask-cors numpy Pillow noise scipy gunicorn

# 6. Test et
python3 -c "from flask import Flask; print('Flask OK')"
python3 -c "import numpy; print('Numpy OK')"
python3 -c "from noise import pnoise2; print('Noise OK')"

# 7. Gunicorn ile başlat (test)
# gunicorn app:app --bind 0.0.0.0:5001 --timeout 120

echo ""
echo "✅ Kurulum tamamlandı!"
echo ""
echo "Test: gunicorn app:app --bind 0.0.0.0:5001 --timeout 120"
echo "Tarayıcı: http://SUNUCU_IP:5001"
