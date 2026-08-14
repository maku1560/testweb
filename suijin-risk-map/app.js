(() => {
  'use strict';

  const GSI_TILES = 'https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png';
  const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
  const OVERPASS_ENDPOINTS = [
    'https://overpass.private.coffee/api/interpreter',
    'https://overpass-api.de/api/interpreter',
    'https://maps.mail.ru/osm/tools/overpass/api/interpreter'
  ];
  const OVERPASS_TIMEOUT_MS = 9000;

  const STRICT_TERMS = [
    { re: /水神|水神社|水神宮/, label: '水神', weight: 1.0, strength: 'strong' },
    { re: /水天宮|水天社/, label: '水天宮', weight: 0.95, strength: 'strong' },
    { re: /龍神|竜神/, label: '龍神', weight: 0.90, strength: 'strong' },
    { re: /弁財天|弁天堂|弁天社|弁天宮/, label: '弁財天', weight: 0.75, strength: 'medium' }
  ];

  const $ = (id) => document.getElementById(id);
  const ui = {
    form: $('search-form'), input: $('place-input'), locate: $('locate-btn'), radius: $('radius'), radiusLabel: $('radius-label'),
    statusCard: $('status-card'), statusTitle: $('status-title'), statusText: $('status-text'), scoreCard: $('score-card'),
    scoreNumber: $('score-number'), scoreRank: $('score-rank'), meterFill: $('meter-fill'), oracle: $('oracle'), spotCount: $('spot-count'),
    nearestDistance: $('nearest-distance'), strongCount: $('strong-count'), spotsSection: $('spots-section'), resultRadius: $('result-radius'),
    spotList: $('spot-list'), clear: $('clear-btn'), toast: $('toast')
  };

  let searchMarker = null;
  let waterMarkers = [];
  let radiusSourceReady = false;
  let currentPlace = null;
  let requestSerial = 0;

  if (typeof maplibregl === 'undefined') {
    setStatus('error', '地図の読み込みに失敗しました', '地図ライブラリを読み込めませんでした。ページを再読み込みしてな。');
    return;
  }

  const map = new maplibregl.Map({
    container: 'map', center: [138.2, 36.4], zoom: 4.7, minZoom: 3.6, maxZoom: 18,
    style: { version: 8, sources: { gsi: { type: 'raster', tiles: [GSI_TILES], tileSize: 256, attribution: '地理院タイル' } }, layers: [{ id: 'gsi', type: 'raster', source: 'gsi' }] },
    attributionControl: false
  });

  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
  map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');

  map.on('load', () => {
    map.addSource('radius-area', { type: 'geojson', data: emptyFeatureCollection() });
    map.addLayer({ id: 'radius-fill', type: 'fill', source: 'radius-area', paint: { 'fill-color': '#5d4cb4', 'fill-opacity': 0.08 } });
    map.addLayer({ id: 'radius-line', type: 'line', source: 'radius-area', paint: { 'line-color': '#5d4cb4', 'line-width': 1.5, 'line-opacity': 0.45, 'line-dasharray': [2, 2] } });
    radiusSourceReady = true;
  });

  ui.form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const query = ui.input.value.trim();
    if (!query) return showToast('住所・駅名・地名を入力してな。');
    await searchByText(query);
  });

  ui.locate.addEventListener('click', () => {
    if (!navigator.geolocation) return showToast('このブラウザでは現在地を取得できへん。');
    setStatus('loading', '現在地を確認中', '位置情報を取得してるで。');
    navigator.geolocation.getCurrentPosition(
      (pos) => analyzePoint(pos.coords.latitude, pos.coords.longitude, '現在地'),
      () => setStatus('error', '現在地を取得できませんでした', 'ブラウザの位置情報の許可を確認してな。'),
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 }
    );
  });

  ui.radius.addEventListener('input', () => {
    ui.radiusLabel.textContent = `${ui.radius.value} km`;
    if (currentPlace) drawRadius(currentPlace.lat, currentPlace.lon, Number(ui.radius.value));
  });

  ui.radius.addEventListener('change', () => {
    if (currentPlace) analyzePoint(currentPlace.lat, currentPlace.lon, currentPlace.label);
  });

  ui.clear.addEventListener('click', resetAnalysis);
  map.on('click', (event) => analyzePoint(event.lngLat.lat, event.lngLat.lng, '地図で選んだ地点'));

  async function fetchJsonWithTimeout(url, options = {}, timeoutMs = 8000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal, cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async function searchByText(query) {
    setStatus('loading', '地名を検索中', `「${query}」を探してるで。`);
    try {
      const params = new URLSearchParams({ q: query, format: 'jsonv2', countrycodes: 'jp', limit: '1', addressdetails: '1' });
      const results = await fetchJsonWithTimeout(`${NOMINATIM}?${params.toString()}`, { headers: { 'Accept-Language': 'ja' } }, 8000);
      if (!results.length) {
        setStatus('error', '場所が見つかりませんでした', '少し広い地名や市区町村名で試してな。');
        return;
      }
      const hit = results[0];
      const label = hit.display_name?.split(',').slice(0, 3).join('、') || query;
      await analyzePoint(Number(hit.lat), Number(hit.lon), label);
    } catch (error) {
      console.error(error);
      setStatus('error', '地名検索に失敗しました', '地名検索サービスから返事がありませんでした。もう一度試してな。');
    }
  }

  async function analyzePoint(lat, lon, label) {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    const serial = ++requestSerial;
    currentPlace = { lat, lon, label };
    const radiusKm = Number(ui.radius.value);
    placeOriginMarker(lat, lon);
    drawRadius(lat, lon, radiusKm);
    map.flyTo({ center: [lon, lat], zoom: radiusKm <= 5 ? 12 : radiusKm <= 10 ? 11 : 10.2, essential: true });
    ui.clear.classList.remove('hidden');
    ui.scoreCard.classList.add('hidden');
    ui.spotsSection.classList.add('hidden');
    clearWaterMarkers();
    setStatus('loading', '水神を探索中', `${label}の周辺 ${radiusKm} km を調べてるで。検索先を順番に切り替える。`);

    try {
      const spots = await fetchWaterSpots(lat, lon, radiusKm, serial);
      if (serial !== requestSerial) return;
      renderResults(spots, radiusKm, label);
    } catch (error) {
      if (serial !== requestSerial) return;
      console.error(error);
      setStatus('error', '水神データを取得できませんでした', '公開検索サービスが混雑中やったため打ち切ったで。地図と地名検索は使える。もう一度検索すると再試行する。');
    }
  }

  async function fetchWaterSpots(lat, lon, radiusKm, serial) {
    const meters = Math.round(radiusKm * 1000);
    const regex = '水神|水神社|水神宮|水天宮|水天社|龍神|竜神|弁財天|弁天堂|弁天社|弁天宮';
    const query = `[out:json][timeout:7];(nwr(around:${meters},${lat},${lon})[name~"${regex}"];);out center tags qt;`;
    let lastError = new Error('Overpass unavailable');

    for (let i = 0; i < OVERPASS_ENDPOINTS.length; i++) {
      if (serial !== requestSerial) throw new Error('stale request');
      setStatus('loading', '水神を探索中', `検索経路 ${i + 1}/${OVERPASS_ENDPOINTS.length} を確認中…`);
      try {
        const data = await fetchJsonWithTimeout(
          OVERPASS_ENDPOINTS[i],
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8', Accept: 'application/json' },
            body: `data=${encodeURIComponent(query)}`
          },
          OVERPASS_TIMEOUT_MS
        );
        return normalizeOverpass(data.elements || [], lat, lon, radiusKm);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  }

  function normalizeOverpass(elements, lat, lon, radiusKm) {
    const seen = new Set();
    const spots = [];
    for (const el of elements) {
      const key = `${el.type}/${el.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const name = el.tags?.name || el.tags?.['name:ja'] || '';
      if (!name) continue;
      const pointLat = el.lat ?? el.center?.lat;
      const pointLon = el.lon ?? el.center?.lon;
      if (!Number.isFinite(pointLat) || !Number.isFinite(pointLon)) continue;
      const matched = classifyName(name);
      if (!matched) continue;
      const distanceKm = haversineKm(lat, lon, pointLat, pointLon);
      if (distanceKm > radiusKm + 0.2) continue;
      spots.push({ id: key, name, lat: pointLat, lon: pointLon, distanceKm, category: matched.label, weight: matched.weight, strength: matched.strength });
    }
    return spots.sort((a, b) => a.distanceKm - b.distanceKm);
  }

  function classifyName(name) { return STRICT_TERMS.find((term) => term.re.test(name)) || null; }

  function calculateScore(spots, radiusKm) {
    if (!spots.length) return 0;
    let raw = 0;
    for (const spot of spots) {
      const normalized = Math.max(0, 1 - spot.distanceKm / radiusKm);
      const distancePoints = 3 + 27 * Math.pow(normalized, 1.7);
      raw += distancePoints * spot.weight;
    }
    return Math.min(100, Math.round(100 * (1 - Math.exp(-raw / 62))));
  }

  function rankFor(score) {
    if (score < 15) return { label: '平穏', oracle: '水の神々は、いまのところ遠巻きに見ているようです。' };
    if (score < 35) return { label: '水の気配あり', oracle: 'ぽつり、ぽつりと水の神。昔の人が水を意識した土地なのかもしれません。知らんけど。' };
    if (score < 60) return { label: '水神の守備範囲', oracle: '周囲に水の神々が集まりはじめました。土地と水の関係を掘ると何か出てきそうです。' };
    if (score < 80) return { label: '水神密集地帯', oracle: '水神、龍神、弁天。だいぶ集まっています。偶然としては少し賑やかです。' };
    return { label: '人類、水と戦いすぎ', oracle: '水の神々が過密です。昔の人、ここで水について何か言いたかった可能性があります。科学的には何も言えません。' };
  }

  function renderResults(spots, radiusKm, label) {
    const score = calculateScore(spots, radiusKm);
    const rank = rankFor(score);
    const strong = spots.filter((spot) => spot.strength === 'strong').length;
    const nearest = spots[0]?.distanceKm;

    setStatus('idle', label, spots.length ? `${radiusKm} km以内で ${spots.length}件の候補が見つかったで。` : `${radiusKm} km以内では、水神系の名称を持つ候補が見つからへんかった。`);
    ui.scoreNumber.textContent = String(score);
    ui.scoreRank.textContent = rank.label;
    ui.meterFill.style.width = `${score}%`;
    ui.oracle.textContent = rank.oracle;
    ui.spotCount.textContent = String(spots.length);
    ui.strongCount.textContent = String(strong);
    ui.nearestDistance.textContent = Number.isFinite(nearest) ? formatDistance(nearest) : '—';
    ui.resultRadius.textContent = `半径 ${radiusKm} km`;
    ui.scoreCard.classList.remove('hidden');

    if (spots.length) {
      ui.spotsSection.classList.remove('hidden');
      ui.spotList.innerHTML = '';
      for (const spot of spots.slice(0, 20)) {
        addWaterMarker(spot);
        const li = document.createElement('li');
        li.className = 'spot-item';
        li.innerHTML = `<div class="spot-icon">${escapeHtml(spot.category.slice(0, 1))}</div><div><div class="spot-name">${escapeHtml(spot.name)}</div><div class="spot-meta">${escapeHtml(spot.category)}・名称からの自動判定</div></div><div class="spot-distance">${formatDistance(spot.distanceKm)}</div>`;
        li.addEventListener('click', () => map.flyTo({ center: [spot.lon, spot.lat], zoom: 15, essential: true }));
        ui.spotList.appendChild(li);
      }
      for (const spot of spots.slice(20)) addWaterMarker(spot);
    } else {
      ui.spotsSection.classList.add('hidden');
    }
  }

  function placeOriginMarker(lat, lon) {
    if (searchMarker) searchMarker.remove();
    const el = document.createElement('div');
    el.className = 'marker-origin';
    searchMarker = new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat([lon, lat]).addTo(map);
  }

  function addWaterMarker(spot) {
    const el = document.createElement('div');
    el.className = 'marker-water';
    const popup = new maplibregl.Popup({ offset: 19, closeButton: false }).setHTML(`<div class="popup-title">${escapeHtml(spot.name)}</div><div class="popup-meta">${escapeHtml(spot.category)}・${formatDistance(spot.distanceKm)}</div>`);
    const marker = new maplibregl.Marker({ element: el, anchor: 'bottom' }).setLngLat([spot.lon, spot.lat]).setPopup(popup).addTo(map);
    waterMarkers.push(marker);
  }

  function clearWaterMarkers() {
    waterMarkers.forEach((marker) => marker.remove());
    waterMarkers = [];
  }

  function drawRadius(lat, lon, radiusKm) {
    if (!radiusSourceReady || !map.getSource('radius-area')) return;
    const points = [];
    const steps = 72;
    const latRad = lat * Math.PI / 180;
    const latDegree = 111.32;
    const lonDegree = 111.32 * Math.cos(latRad);
    for (let i = 0; i <= steps; i++) {
      const angle = 2 * Math.PI * i / steps;
      points.push([lon + (radiusKm * Math.cos(angle)) / lonDegree, lat + (radiusKm * Math.sin(angle)) / latDegree]);
    }
    map.getSource('radius-area').setData({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [points] } }] });
  }

  function resetAnalysis() {
    requestSerial++;
    currentPlace = null;
    if (searchMarker) { searchMarker.remove(); searchMarker = null; }
    clearWaterMarkers();
    if (radiusSourceReady && map.getSource('radius-area')) map.getSource('radius-area').setData(emptyFeatureCollection());
    ui.scoreCard.classList.add('hidden');
    ui.spotsSection.classList.add('hidden');
    ui.clear.classList.add('hidden');
    setStatus('idle', '場所を検索', '地点を選ぶと、周辺の水神系スポットを調べるで。');
    map.flyTo({ center: [138.2, 36.4], zoom: 4.7 });
  }

  function setStatus(type, title, text) {
    ui.statusCard.className = `status-card ${type}`;
    ui.statusTitle.textContent = title;
    ui.statusText.textContent = text;
  }

  function formatDistance(km) { return km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(1)} km`; }

  function haversineKm(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function emptyFeatureCollection() { return { type: 'FeatureCollection', features: [] }; }

  function escapeHtml(value) {
    return String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
  }

  function showToast(message) {
    ui.toast.textContent = message;
    ui.toast.classList.add('show');
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => ui.toast.classList.remove('show'), 2600);
  }
})();
