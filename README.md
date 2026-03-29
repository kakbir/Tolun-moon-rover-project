# Ay Kesif Sistemi - Otonom Lunar Navigasyon Platformu

Gercek NASA verileriyle calisan, Dunya'dan bagimsiz karar alabilen tam otonom Ay kesif ve navigasyon sistemi.

**Canli Demo:** [https://tolun.kakbir.com](https://tolun.kakbir.com)

> TUA Astro Hackathon 2026 | Gorev: Ay Yuzeyi Icin Otonom Rota Optimizasyonu

---

## Problem

Mevcut Ay rover'lari Dunya'dan komut beklemek zorunda:

| Rover | Ulke | Sonuc |
|-------|------|-------|
| Pragyan | Hindistan | 14 gunde 103 metre (her 5m'de 5 saat bekleme) |
| Yutu-2 | Cin | 5 yilda 1.5 km |
| VIPER | NASA | 450M$ harcanip iptal edildi |

Ay'da GPS yok, iletisim 1.3 saniye gecikmeli ve uydudan gorunmeyen 30 cm'lik bir kaya rover'i devirebilir.

## Cozum: Iki Katmanli Algilama Mimarisi

Mevcut hicbir Ay rover'inda bulunmayan iki katmanli yaklasim:

### Katman 1 - Uydu Gozu (Makro Planlama)
- NASA Moon Trek WMTS uydu goruntuleri
- NASA LOLA Lazer Altimetre gercek yukseklik verileri
- Otomatik krater tespiti
- A* algoritmasi ile egim bazli guvenli rota planlama

### Katman 2 - Rover On Kamerasi (Mikro Karar)
- Uydu cozunurlugunde gorunmeyen kucuk engelleri gercek zamanli algilama
- Dunya'dan komut beklemeden otonom rota degisikligi
- 1.3 sn iletisim gecikmesini tamamen bypass etme

## Tam Otonom Kesif Dongusu

```
BASE --> Hedef Sec --> Rota Hesapla --> Hedefe Git
 ^                                        |
 |                                   Engel Tespit
 |                                   & Kacinma
 |                                        |
 +-- Rota Arsivle <-- Base'e Don <-- Kesfet & Kaydet
```

Dunya'dan sadece "Basla" tusuna basilmasi yeterli. Gerisi tamamen otonom.

## Teknik Altyapi

- **Veri:** Gercek NASA LOLA DEM yukseklik verileri (simulasyon degil)
- **3D Arazi:** 200x200 cozunurlukte Three.js dijital ikiz
- **Pathfinding:** A* algoritmasi ile egim analizi ve rota optimizasyonu
- **Engel Tespiti:** On kamera algilama + yerel rota yeniden hesaplama
- **Backend:** Python / Flask
- **Frontend:** Vanilla JS / Three.js / NASA WMTS

## Kurulum

```bash
# Klonla
git clone https://github.com/KULLANICI/moon.git
cd moon

# Sanal ortam
python3 -m venv venv
source venv/bin/activate

# Bagimliliklar
pip install flask flask-cors numpy Pillow noise scipy gunicorn

# Calistir
python app.py
```

Tarayicida `http://localhost:5001` adresini ac.

## Milli Uzay Programi Uyumu

| Hedef | Katkimiz |
|-------|----------|
| 2027 - Sert Inis | Uydu analiz altyapisi inis noktasi secimi |
| 2030 - Yumusak Inis | Rover navigasyon sistemi gorev yazilim omurgasi |
| Sonrasi - Otonom Us | Kesintisiz kesif dongusu insansiz operasyonlar |

Acik kaynak NASA verileri ile calisir. TUA / GOKTURK entegrasyonuna hazir.

---

TUA Astro Hackathon 2026
