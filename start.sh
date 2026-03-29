#!/bin/bash

echo "🌙 Ay Rover Simülasyonu"
echo "======================="
echo ""
echo "Python Backend + Babylon.js Frontend"
echo ""

# Activate venv
source venv/bin/activate

# Start Flask server
echo "🚀 Flask server başlatılıyor..."
echo "Backend: http://localhost:5001"
echo "Frontend: http://localhost:5001"
echo ""
echo "Tarayıcınızda http://localhost:5001 adresini açın"
echo ""
echo "Durdurmak için: Ctrl+C"
echo ""

python app.py
