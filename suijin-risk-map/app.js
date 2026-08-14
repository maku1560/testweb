(() => {
  'use strict';

  const GSI_TILES = 'https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png';
  const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
  const OVERPASS_ENDPOINTS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter'
  ];

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
  let lastRequestController = null;

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

  async function searchByText(query) {
    setStatus('loading', '地名を検索中', `「${query}」を探してるで。`);
    try {
      const params = new URLSearchParams({ q: query, format: 'jsonv2', countrycodes: 'jp', limit: '1', addressdetails: '1' });
      const response = await fetch(`${NOMINATIM}?${params.toString()}`, { headers: { 'Accept-Language': 'ja' } });
      if (!response.ok) throw new Error(`Geocoder ${response.status}`);
      const results = await response.json();
      if (!results.length) {
        setStatus('error', '場所が見つかりませんでした', '少し広い地名や市区町村名で試してな。');
        return;
      }
      const hit = results[0];
      const label = hit.display_name?.split(',').slice(0, 3).join('、') || query;
      await analyzePoint(Number(hit.lat), Number(hit.lon), label);
    } catch (error) {
      console.error(error);
      setStatus('error', '地名検索に失敗しました', '外部の地名検索サービスが混雑している可能性があるで。少し後でもう一度試してな。');
    }
  }

  async function analyzePoint(lat, lon, label) {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    if (lastRequestController) lastRequestController.abort();
    lastRequestController = new AbortController();
    currentPlace = { lat, lon, label };
    const radiusKm = Number(ui.radius.value);
    placeOriginMarker(lat, lon);
    drawRadius(lat, lon, radiusKm);
    map.flyTo({ center: [lon, lat], zoom: radiusKm <= 5 ? 12 : radiusKm <= 10 ? 11 : 10.2, essential: true });
    ui.clear.classList.remove('hidden');
    ui.scoreCard.classList.add('hidden');
    ui.spotsSection.classList.add('hidden');
    clearWaterMarkers();
    setStatus('loading', '水神を探索中', `${label}の周辺 ${radiusKm} km を調べてるで。`);

    try {
      const spots = await fetchWaterSpots(lat, lon, radiusKm, lastRequestController.signal);
      renderResults(spots, lat, lon, radiusKm, label);
    } catch (error) {
      if (error.name === 'AbortError') return;
      console.error(error);
      setStatus('error', '水神の探索に失敗しました', 'OpenStreetMapの検索サービスが混雑している可能性があるで。地図自体はそのまま使える。');
    }
  }

  async function fetchWaterSpots(lat, lon, radiusKm, signal) {
    const meters = Math.round(radiusKm * 1000);
    const regex = '水神|水神社|水神宮|水天宮|水天社|龍神|竜神|弁財天|弁天堂|弁天社|弁天宮';
    const q = `[out:json][timeout:25];\n(\n` +
      `nwr(around:${meters},${lat},${lon})["amenity"="place_of_worship"]["name"~"${regex}"];\n` +
      `nwr(around:${meters},${lat},${lon})["historic"="wayside_shrine"]["name"~"${regex}"];\n` +
      `nwr(around:${meters},${lat},${lon})["religion"="shinto"]["name"~"${regex}"];\n` +
      `);\nout center tags;`;

    let lastError;
    for (const endpoint of OVERPASS_ENDPOINTS) {
      try {
        const response = await fetch(endpoint, {
          method: 'POST', body: new URLSearchParams({ data: q }), signal,
          headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' }
        });
        if (!response.ok) throw new Error(`Overpass ${response.status}`);
        const data = await response.json();
        return normalizeOverpass(data.elements || [], lat, lon, radiusKm);
      } catch (error) {
        if (error.name === 'AbortError') throw error;
        lastError = error;
      }
    }
    throw lastError || new Error('Overpass unavailable');
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
      spots.push({ id: key, name, lat: pointLat, lon: pointLon, distanceKm, category: matched.label, weight: matched.weight, strength: matched.strength, tags: el.tags || {} });
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

  function renderResults(spots, lat, lon, radiusKm, label) {
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
      if (spots.length > 20) {
        const more = document.createElement('li');
        more.className = 'spot-item';
        more.innerHTML = `<div class="spot-icon">+</div><div><div class="spot-name">ほか ${spots.length - 20}件</div><div class="spot-meta">地図上には候補を表示</div></div><div></div>`;
        ui.spotList.appendChild(more);
        for (const spot of spots.slice(20)) addWaterMarker(spot);
      }
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

  function clearWaterMarkers() { waterMarkers.forEach((m) => m.remove()); waterMarkers = []; }

  function resetAnalysis() {
    if (lastRequestController) lastRequestController.abort();
    currentPlace = null;
    if (searchMarker) { searchMarker.remove(); searchMarker = null; }
    clearWaterMarkers();
    if (radiusSourceReady) map.getSource('radius-area').setData(emptyFeatureCollection());
    ui.scoreCard.classList.add('hidden');
    ui.spotsSection.classList.add('hidden');
    ui.clear.classList.add('hidden');
    setStatus('idle', '場所を検索', '地点を選ぶと、周辺の水神系スポットを調べるで。');
    map.flyTo({ center: [138.2, 36.4], zoom: 4.7, essential: true });
  }

  function drawRadius(lat, lon, radiusKm) { if (radiusSourceReady) map.getSource('radius-area').setData(circleGeoJSON(lon, lat, radiusKm)); }

  function circleGeoJSON(lon, lat, radiusKm, steps = 72) {
    const coords = [];
    const earthRadius = 6371.0088;
    const angular = radiusKm / earthRadius;
    const lat1 = toRad(lat);
    const lon1 = toRad(lon);
    for (let i = 0; i <= steps; i++) {
      const bearing = (2 * Math.PI * i) / steps;
      const lat2 = Math.asin(Math.sin(lat1) * Math.cos(angular) + Math.cos(lat1) * Math.sin(angular) * Math.cos(bearing));
      const lon2 = lon1 + Math.atan2(Math.sin(bearing) * Math.sin(angular) * Math.cos(lat1), Math.cos(angular) - Math.sin(lat1) * Math.sin(lat2));
      coords.push([toDeg(lon2), toDeg(lat2)]);
    }
    return { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [coords] } }] };
  }

  function emptyFeatureCollection() { return { type: 'FeatureCollection', features: [] }; }

  function haversineKm(lat1, lon1, lat2, lon2) {
    const R = 6371.0088;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function toRad(v) { return v * Math.PI / 180; }
  function toDeg(v) { return v * 180 / Math.PI; }
  function formatDistance(km) { return km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(km < 10 ? 1 : 0)} km`; }
  function setStatus(kind, title, text) { ui.statusCard.className = `status-card ${kind}`; ui.statusTitle.textContent = title; ui.statusText.textContent = text; }
  function showToast(message) { ui.toast.textContent = message; ui.toast.classList.add('show'); clearTimeout(showToast.timer); showToast.timer = setTimeout(() => ui.toast.classList.remove('show'), 2400); }
  function escapeHtml(value) { return String(value).replace(/[&<>'"]/g, (char) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[char])); }
})();
