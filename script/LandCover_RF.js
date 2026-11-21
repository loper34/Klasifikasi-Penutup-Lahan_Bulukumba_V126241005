/*******************************************************************
 * KLASIFIKASI PENUTUP LAHAN DENGAN RANDOM FOREST
 * Platform : Google Earth Engine (GEE) Code Editor
 * Citra    : Sentinel-2 Level-2A (Surface Reflectance)
 * Kelas    : 1 Vegetasi | 2 Sawah | 3 Badan Air | 4 Lahan Terbuka | 5 Lahan Terbangun


/*******************************************************************
 * 1. AREA KAJIAN
 *******************************************************************/

var aoi = ee.FeatureCollection('projects/petakepintaran/assets/KabBulukumba').geometry();

// Zoom peta ke lokasi kajian. Angka 11 = tingkat zoom (makin besar makin dekat).
Map.centerObject(aoi, 11);
Map.addLayer(aoi, {color: 'red'}, 'Area Kajian');

// Cek luas area. `.area()` hasilnya meter persegi, dibagi 10000 = hektar.
// `print` menampilkan hasil di tab Console (sebelah kanan).
print('Luas area kajian (ha):', aoi.area().divide(10000));


/*******************************************************************
 * 2. PEMANGGILAN DAN PRA-PEMROSESAN CITRA
 *******************************************************************/

// Periode citra. Ubah sesuai kebutuhan lokasimu.
// KENAPA penting? Penutup lahan bisa berubah menurut musim, jadi periodenya
// sebaiknya tidak terlalu panjang dan masuk akal untuk wilayahmu.
var tglMulai = '2025-01-01';
var tglAkhir = '2025-12-31';

// Band yang dipakai (nama kode band Sentinel-2):
// B2 = biru, B3 = hijau, B4 = merah, B8 = inframerah dekat (NIR),
// B11 = SWIR 1, B12 = SWIR 2
var bandOptik = ['B2', 'B3', 'B4', 'B8', 'B11', 'B12'];

// Ambil koleksi citra Sentinel-2 yang:
//  - menutupi wilayahmu (filterBounds)
//  - berada di rentang tanggal yang ditentukan (filterDate)
//  - persentase awannya kurang dari 50% (filter awal yang kasar saja)
var s2 = ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
  .filterBounds(aoi)
  .filterDate(tglMulai, tglAkhir)
  .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 50));

print('Jumlah citra tersedia:', s2.size());
// Kalau hasilnya 0: perlebar rentang tanggal, atau cek lagi `aoi`-nya.

// Cloud Score+ = koleksi dari Google yang memberi "skor kejernihan" tiap piksel.
// Band 'cs_cdf' nilainya 0 (berawan) sampai 1 (jernih).
var csPlus = ee.ImageCollection('GOOGLE/CLOUD_SCORE_PLUS/V1/S2_HARMONIZED');

// Batas kejernihan. Piksel dengan skor di bawah ini dibuang (di-mask).
// Naikkan kalau masih banyak awan; turunkan kalau terlalu banyak piksel hilang.
var batasJernih = 0.6;

// Proses tiap citra:
//  1) gabungkan dengan Cloud Score+  (linkCollection)
//  2) buang piksel berawan           (updateMask)
//  3) pilih band optik saja          (select)
//  4) bagi 10000                     (divide)
// KENAPA dibagi 10000? Nilai asli Sentinel-2 berupa bilangan bulat besar.
// Dibagi 10000 supaya jadi nilai pantulan 0-1 yang lazim dipakai.
var s2Bersih = s2
  .linkCollection(csPlus, ['cs_cdf'])
  .map(function(img) {
    var jernih = img.select('cs_cdf').gte(batasJernih);
    return img.updateMask(jernih).select(bandOptik).divide(10000);
  });

// Gabungkan semua citra jadi SATU citra komposit pakai median.
// KENAPA median? Nilai tengah tidak mudah terpengaruh nilai ekstrem
// (misal sisa awan atau bayangan) dibanding rata-rata.
// clip(aoi) = potong hasilnya sesuai batas area kajian.
var komposit = s2Bersih.median().clip(aoi);

// Tampilkan komposit warna asli (merah, hijau, biru).
var visRGB = {bands: ['B4', 'B3', 'B2'], min: 0, max: 0.3};
Map.addLayer(komposit, visRGB, 'Komposit Sentinel-2 (RGB)');


/*******************************************************************
 * 3. PENAMBAHAN PREDIKTOR (INDEKS SPEKTRAL + TOPOGRAFI)
 *    Prediktor = "petunjuk" yang dipakai model untuk membedakan kelas.
 *******************************************************************/

// --- Indeks spektral ---
// normalizedDifference(['A','B']) menghitung (A - B) / (A + B)

// NDVI: menonjolkan vegetasi. Tumbuhan hijau memantulkan banyak NIR
// dan menyerap merah, jadi nilainya tinggi di vegetasi.
var ndvi = komposit.normalizedDifference(['B8', 'B4']).rename('NDVI');

// MNDWI: menonjolkan air. Air memantulkan hijau lebih besar dari SWIR.
var mndwi = komposit.normalizedDifference(['B3', 'B11']).rename('MNDWI');

// NDBI: menonjolkan area terbangun. Bangunan memantulkan SWIR lebih besar dari NIR.
var ndbi = komposit.normalizedDifference(['B11', 'B8']).rename('NDBI');

// BSI: menonjolkan tanah terbuka. Rumusnya lebih panjang,
// jadi pakai expression() agar rumus ditulis apa adanya.
var bsi = komposit.expression(
  '((SWIR + RED) - (NIR + BLUE)) / ((SWIR + RED) + (NIR + BLUE))', {
    SWIR: komposit.select('B11'),
    RED:  komposit.select('B4'),
    NIR:  komposit.select('B8'),
    BLUE: komposit.select('B2')
  }).rename('BSI');

// --- Topografi (dari data SRTM) ---
// Elevasi (ketinggian) membantu membedakan mis. sawah/pesisir vs hutan perbukitan.
var elevasi = ee.Image('USGS/SRTMGL1_003').select('elevation').clip(aoi);
// Slope = kemiringan lereng (derajat), dihitung dari elevasi.
var slope = ee.Terrain.slope(elevasi);

// Gabungkan semua band jadi SATU citra prediktor.
// addBands = menambah band ke citra. toFloat = samakan tipe angka (desimal).
var prediktor = komposit
  .addBands([ndvi, mndwi, ndbi, bsi, elevasi, slope])
  .toFloat();

var namaPrediktor = prediktor.bandNames();
print('Daftar prediktor:', namaPrediktor);

Map.addLayer(ndvi, {min: -0.2, max: 0.9, palette: ['blue', 'white', 'green']},
  'NDVI', false); // `false` = layer dimatikan dulu, nyalakan lewat menu Layers


/*******************************************************************
 * 4. PENGAMBILAN SAMPEL
 *******************************************************************/

// Daftar kelas: urutan harus sama antara ID, nama, dan warna.
var idKelas   = [1, 2, 3, 4, 5];
var namaKelas = ['Vegetasi', 'Sawah', 'Badan Air', 'Lahan Terbuka', 'Lahan Terbangun'];
var palet     = ['#1E8C1E', '#F5C518', '#0000FF', '#a65f04', '#e80707'];

// Panggil titik sampel dari asset (hasil upload shapefile QGIS).
var asetSampel = ee.FeatureCollection('projects/petakepintaran/assets/SampleRFBulukumba');

var kamusKelas = ee.Dictionary({
  'vegetasi': 1,
  'sawah': 2,
  'badan air': 3,
  'lahan terbuka': 4,
  'lahan terbangun': 5
});

// Untuk tiap titik: ambil nama kelasnya, rapikan (hapus spasi di pinggir
// dan jadikan huruf kecil), cari angkanya di kamus, lalu simpan lagi
// sebagai `kelas`. Kalau nama tidak ada di kamus, hasilnya 0.
var semuaSampel = asetSampel.map(function(titik) {
  var nama = ee.String(titik.get('kelas')).trim().toLowerCase();
  return titik.set('kelas', kamusKelas.get(nama, 0));
});

// Cek tampilan satu titik. Pastikan ada kolom `kelas` dan nilainya angka.
print('Contoh satu titik:', semuaSampel.first());

// Cek jumlah sampel per kelas (wajib dilaporkan di README).
print('Jumlah sampel per kelas (semua):', semuaSampel.aggregate_histogram('kelas'));


/*******************************************************************
 * 5. PEMBAGIAN DATA LATIH, VALIDASI, DAN UJI
 *******************************************************************/

// randomColumn memberi setiap titik angka acak 0-1. Angka 42 = "seed",
// supaya pembagiannya sama setiap kali script dijalankan (bisa direproduksi).
var acak = semuaSampel.randomColumn('acak', 42);

// Dibagi tiga:
//  - 60% LATIH   : untuk melatih model
//  - 20% VALIDASI: untuk memilih parameter terbaik (tuning)
//  - 20% UJI     : untuk nilai akurasi akhir, tidak boleh dipakai di langkah lain
// KENAPA tiga bagian? Kalau data uji ikut dipakai memilih parameter,
// akurasinya jadi terlalu optimis. Dengan data uji yang "murni",
// nilai akurasi akhir lebih jujur.
var titikLatih = acak.filter(ee.Filter.lt('acak', 0.6));
var titikValid = acak.filter(ee.Filter.and(
  ee.Filter.gte('acak', 0.6), ee.Filter.lt('acak', 0.8)));
var titikUji   = acak.filter(ee.Filter.gte('acak', 0.8));

print('Sampel latih per kelas:',  titikLatih.aggregate_histogram('kelas'));
print('Sampel validasi per kelas:', titikValid.aggregate_histogram('kelas'));
print('Sampel uji per kelas:',    titikUji.aggregate_histogram('kelas'));

// Ambil nilai semua prediktor di lokasi tiap titik.
// Hasilnya tabel: satu baris per titik, kolomnya nilai band + kelas.
function ambilNilai(titik) {
  return prediktor.sampleRegions({
    collection: titik,
    properties: ['kelas'],
    scale: 10,      // resolusi 10 meter (sesuai resolusi terbaik Sentinel-2)
    tileScale: 4    // membagi pekerjaan jadi potongan kecil agar tidak kehabisan memori
  });
}

var dataLatih = ambilNilai(titikLatih);
var dataValid = ambilNilai(titikValid);
var dataUji   = ambilNilai(titikUji);

// Tampilkan sebaran titik latih dan uji per kelas di peta (untuk gambar 03 & 04).
for (var i = 0; i < idKelas.length; i++) {
  Map.addLayer(titikLatih.filter(ee.Filter.eq('kelas', idKelas[i])),
    {color: palet[i]}, 'Latih - ' + namaKelas[i], false);
  Map.addLayer(titikUji.filter(ee.Filter.eq('kelas', idKelas[i])),
    {color: palet[i]}, 'Uji - ' + namaKelas[i], false);
}


/*******************************************************************
 * 6. PELATIHAN RANDOM FOREST + HYPERPARAMETER TUNING
 *******************************************************************/

// Random Forest = kumpulan banyak "pohon keputusan" yang saling voting.
// Dua parameter yang kita coba-coba:
//  - numberOfTrees     : jumlah pohon (lebih banyak = lebih stabil, tapi lebih lama)
//  - variablesPerSplit : jumlah prediktor yang boleh "dilihat" pohon saat
//                        memecah data di satu cabang
var daftarPohon = ee.List([50, 100, 200, 300]);
var daftarVariabel = ee.List([2, 4, 6, 8]); // tidak boleh lebih dari jumlah prediktor (12)

// Grid search = coba SEMUA kombinasi (4 x 4 = 16 model).
// Tiap model dilatih pakai data latih, lalu dinilai pakai data VALIDASI.
var hasilTuning = daftarPohon.map(function(n) {
  return daftarVariabel.map(function(v) {
    var model = ee.Classifier.smileRandomForest({
      numberOfTrees: n,
      variablesPerSplit: v,
      seed: 42
    }).train({
      features: dataLatih,
      classProperty: 'kelas',        // kolom yang berisi jawaban (label)
      inputProperties: namaPrediktor // kolom yang dipakai sebagai petunjuk
    });

    // classify = minta model menebak kelas, errorMatrix = bandingkan tebakan
    // dengan kelas sebenarnya, accuracy = proporsi tebakan yang benar.
    var akurasi = dataValid
      .classify(model)
      .errorMatrix('kelas', 'classification')
      .accuracy();

    return ee.Feature(null, {pohon: n, variabel: v, akurasi: akurasi});
  });
}).flatten(); // flatten = ratakan list di dalam list jadi satu list

var tabelTuning = ee.FeatureCollection(hasilTuning);
print('Hasil tuning (akurasi data validasi):', tabelTuning);

// Ambil kombinasi dengan akurasi tertinggi.
var terbaik = tabelTuning.sort('akurasi', false).first(); // false = urut dari terbesar
print('Kombinasi parameter terbaik:', terbaik);

// Latih model FINAL memakai parameter terbaik.
// Data latih dan validasi digabung supaya model belajar dari lebih banyak
// contoh. Data uji tetap tidak disentuh.
var modelFinal = ee.Classifier.smileRandomForest({
  numberOfTrees: ee.Number(terbaik.get('pohon')),
  variablesPerSplit: ee.Number(terbaik.get('variabel')),
  seed: 42
}).train({
  features: dataLatih.merge(dataValid),
  classProperty: 'kelas',
  inputProperties: namaPrediktor
});


/*******************************************************************
 * 7. KLASIFIKASI
 *******************************************************************/

// Terapkan model ke SEMUA piksel di citra prediktor.
// Hasilnya citra dengan satu band bernama 'classification' berisi angka 1-4.
var klasifikasi = prediktor.classify(modelFinal);

var visKlas = {min: 1, max: 5, palette: palet};
Map.addLayer(klasifikasi, visKlas, 'Peta Klasifikasi Penutup Lahan');

// Legenda sederhana di pojok peta (untuk gambar 05).
var legenda = ui.Panel({
  style: {position: 'bottom-right', padding: '8px 12px', backgroundColor: 'white'}
});
legenda.add(ui.Label('Penutup Lahan', {fontWeight: 'bold', margin: '0 0 6px 0'}));
for (var j = 0; j < idKelas.length; j++) {
  legenda.add(ui.Panel({
    widgets: [
      ui.Label('', {backgroundColor: palet[j], padding: '8px', margin: '0 6px 4px 0'}),
      ui.Label(namaKelas[j], {margin: '2px 0'})
    ],
    layout: ui.Panel.Layout.Flow('horizontal')
  }));
}
Map.add(legenda);


/*******************************************************************
 * 8. EVALUASI AKURASI (pakai DATA UJI)
 *******************************************************************/

// Model menebak kelas pada titik uji yang belum pernah dilihatnya.
var hasilUji = dataUji.classify(modelFinal);

// Confusion matrix: tabel "kelas sebenarnya" (baris) vs "tebakan model" (kolom).
// Angka di diagonal = tebakan benar. Angka di luar diagonal = salah tebak,
// dari situ kelihatan kelas mana yang sering tertukar.
// `order` menjaga urutan baris/kolom sesuai ID kelas.
var cm = hasilUji.errorMatrix('kelas', 'classification', idKelas);

print('Confusion Matrix:', cm);
print('Overall Accuracy:', cm.accuracy());   // proporsi seluruh tebakan yang benar
print('Kappa:', cm.kappa());                 // akurasi setelah memperhitungkan tebakan kebetulan

// Producer's Accuracy: dari semua titik SEBENARNYA kelas X, berapa yang
// berhasil ditebak X? (urutan = kelas 1, 2, 3, 4)
print("Producer's Accuracy:", cm.producersAccuracy().toList().flatten());
// User's Accuracy: dari semua titik yang DITEBAK kelas X, berapa yang
// benar-benar X?
print("User's Accuracy:", cm.consumersAccuracy().toList().flatten());

// Feature importance: prediktor mana yang paling berpengaruh bagi model.
var penting = ee.Dictionary(modelFinal.explain().get('importance'));
var fcPenting = ee.FeatureCollection(
  penting.keys().map(function(kunci) {
    return ee.Feature(null, {prediktor: kunci, nilai: penting.get(kunci)});
  })
).sort('nilai', false);

print(ui.Chart.feature.byFeature(fcPenting, 'prediktor', 'nilai')
  .setChartType('ColumnChart')
  .setOptions({
    title: 'Feature Importance',
    hAxis: {title: 'Prediktor'},
    vAxis: {title: 'Importance'},
    legend: {position: 'none'}
  }));

// Luas tiap kelas.
// pixelArea() = citra yang isinya luas tiap piksel (m2), dibagi 10000 jadi hektar.
// Lalu dijumlahkan per kelas lewat reducer sum().group().
// groupField: 1 artinya pengelompokan memakai band ke-2 (band klasifikasi).
var luas = ee.Image.pixelArea().divide(10000)
  .addBands(klasifikasi)
  .reduceRegion({
    reducer: ee.Reducer.sum().group({groupField: 1, groupName: 'kelas'}),
    geometry: aoi,
    scale: 10,
    maxPixels: 1e13,
    tileScale: 4
  }).get('groups');

var tabelLuas = ee.FeatureCollection(
  ee.List(luas).map(function(item) {
    var d = ee.Dictionary(item);
    var id = ee.Number(d.get('kelas'));
    return ee.Feature(null, {
      ID_Kelas: id,
      Nama_Kelas: ee.List(namaKelas).get(id.subtract(1).int()),
      Luas_ha: d.get('sum')
    });
  })
);
print('Luas tiap kelas (hektar):', tabelLuas);


/*******************************************************************
 * 9. EKSPOR
 *******************************************************************/

// Setelah Run, buka tab "Tasks" (kanan atas), klik tombol RUN di tiap
// tugas ekspor, lalu hasilnya muncul di Google Drive.
Export.image.toDrive({
  image: klasifikasi,
  description: 'Klasifikasi_RF_PenutupLahan',
  folder: 'Earth Engine',
  region: aoi,
  scale: 10,
  maxPixels: 1e13
});

Export.table.toDrive({
  collection: tabelLuas,
  description: 'Luas_Kelas_PenutupLahan',
  folder: 'Earth Engine',
  fileFormat: 'CSV'
});