document.addEventListener('DOMContentLoaded', function () {
    let map, graphicsLayer, cadastralLayer, currentPolygon;
    let manholeLayer, pipeLayer;
    let startPoint = null, endPoint = null;
    let firstManhole = null;
    let routeLayers = [];
    let routeInProgress = false, inputCoordinatesMode = false, firstExitToRoadAdded = false;
    let elevationCache = {};
    let manholes = []; // Global declaration
    const domainUrl = myMapPluginData.domainUrl;
    console.log(domainUrl)

    function normalizeAddress(address) {
        return address.trim()
            .replace(/\s+/g, ' ')
            .replace(/,\s*/g, ', ')
            .replace(/\d{5,}/g, '')
            .replace(/Kauno m\.? sav\.?|Kauno r\.? sav\.?/i, '')
            .replace(/Vilniaus m\.? sav\.?/i, '')
            .replace(/Lietuva/i, '')
            .trim();
    }

    function initializeMap() {
        map = L.map('map').setView([55.1694, 23.8813], 8);

        // Google Satellite Layer
        L.tileLayer('http://{s}.google.com/vt/lyrs=s&x={x}&y={y}&z={z}', {
            subdomains: ['mt0', 'mt1', 'mt2', 'mt3'],
            maxZoom: 20,
            attribution: '© Google'
        }).addTo(map);

        cadastralLayer = L.esri.dynamicMapLayer({
            url: `${myMapPluginData.domainUrl}/wp-json/my_map_plugin/v1/proxy/geoportal/rc_kadastro_zemelapis/MapServer`,
            opacity: 0.7,
            minZoom: 15
        }).addTo(map);

        cadastralLayer.metadata((error, response) => {
            if (!error && response.fullExtent) {
                console.log("Full extent:", response.fullExtent);
                const { ymin, xmin, ymax, xmax } = response.fullExtent;
                map.setMaxBounds(L.latLngBounds([ymin, xmin], [ymax, xmax]));
            } else {
                console.log('Error retrieving metadata or response is empty:', error || 'empty response');
                console.log('Full Response:', response);
            }
        });                 

        graphicsLayer = L.layerGroup().addTo(map);
        manholeLayer = L.layerGroup().addTo(map);
        pipeLayer = L.layerGroup().addTo(map); 

        map.on('zoomend', function() {
            const currentZoom = map.getZoom();
        });

        map.on('click', function(event) {
            handleMapClick(event.latlng);
        });
    }

    // Функция обработки клика по карте
    function handleMapClick(latlng) {
        if (routeInProgress || inputCoordinatesMode) {
            console.log('Маршрут уже создан или режим ручного ввода координат активен. Новые точки не добавляются.');
            return;
        }

        if (!startPoint) {
            startPoint = latlng;
            L.marker(startPoint).addTo(graphicsLayer).bindPopup("Стартовая точка").openPopup();
            console.log("Стартовая точка выбрана:", startPoint);
        } else if (!endPoint) {
            endPoint = latlng;
            L.marker(endPoint).addTo(graphicsLayer).bindPopup("Конечная точка").openPopup();
            console.log("Конечная точка выбрана:", endPoint);

            findNearestRoadAndBuildRoute();  // Строим маршрут
        }
    }

    // Функция сброса карты и маршрута
    function resetMapAndRoute() {
        routeInProgress = inputCoordinatesMode = false;
        startPoint = endPoint = null;

        [graphicsLayer, manholeLayer, pipeLayer].forEach(layer => layer.clearLayers());

        console.log("Маршрут сброшен. Можно снова выбирать точки.");
    }

    function transformCoordinatesWGS84ToUTM(lat, lon) {
        const wgs84 = 'EPSG:4326';
        const utm = 'EPSG:25832';
        const [x, y] = proj4(wgs84, utm, [lon, lat]);
        return [x, y];
    }
    
    function transformCoordinatesUTMToWGS84(x, y) {
        const utm = 'EPSG:25832';
        const wgs84 = 'EPSG:4326';
        const [lon, lat] = proj4(utm, wgs84, [x, y]);
        return [lat, lon];
    }
    
    function searchAddressAndCreatePolygon(address) {
        const normalizedAddress = normalizeAddress(address);
        const nominatimApiUrl = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(normalizedAddress)}&format=json&limit=1`;
    
        fetch(nominatimApiUrl)
            .then(response => response.json())
            .then(data => {
                if (data && data.length > 0) {
                    const location = data[0];
                    const lat = parseFloat(location.lat);
                    const lon = parseFloat(location.lon);
    
                    // Перемещаем карту и задаём начальные координаты
                    map.setView([lat, lon], 16);
    
                    // Отображаем метку на карте
                    drawPoint([lat, lon]);
                    
                    // Получаем и отображаем границы полигона
                    getParcelBoundariesIdentify(lat, lon);
                } else {
                    console.log("Адрес не найден.");
                    console.log("Адрес не найден. Пожалуйста, уточните ввод.");
                }
            })
            .catch(error => {
                console.log("Ошибка при запросе адреса:", error);
            });
    }
    
    function getParcelBoundariesIdentify(lat, lon) {
        const geometry = `${lon},${lat}`;
        const mapExtent = `${lon - 0.001},${lat - 0.001},${lon + 0.001},${lat + 0.001}`;
        const identifyUrl = `${myMapPluginData.domainUrl}/wp-json/my_map_plugin/v1/proxy/geoportal/rc_kadastro_zemelapis/MapServer/identify?geometry=${geometry}&geometryType=esriGeometryPoint&sr=4326&layers=all:15&tolerance=5&mapExtent=${mapExtent}&imageDisplay=800,600,96&returnGeometry=true&f=json`;
    
        fetch(identifyUrl)
            .then(response => response.json())
            .then(data => {
                if (!data || !data.results || data.results.length === 0) {
                    console.log("No valid data or empty response from GeoPortal.");
                    return;
                }
                const result = data.results[0];
                if (result && result.geometry) {
                    drawGeoJsonPolygon(result.geometry);
                }
            })
            .catch(error => {
                console.error("Error fetching data from GeoPortal:", error);
            });

    }    

    function convertArcGISToGeoJSON(geometry) {
        if (geometry.rings) {
            return {
                "type": "Polygon",
                "coordinates": geometry.rings
            };
        }
    }
    
    function drawGeoJsonPolygon(geometry) {
        const geoJsonData = convertArcGISToGeoJSON(geometry);
        if (currentPolygon) {
            graphicsLayer.removeLayer(currentPolygon);
        }
        currentPolygon = L.geoJSON(geoJsonData, {
            style: function () {
                return { color: 'blue', fillOpacity: 0.1 };
            }
        }).addTo(graphicsLayer);
    
        map.fitBounds(currentPolygon.getBounds());
    }

    function drawMarker(location, color, layer = graphicsLayer) {
        const marker = L.marker([location.lat, location.lon], { color });
        marker.addTo(layer);
        return marker;
    }

    function drawPoint([lat, lon]) {
        if (!lat || !lon) return;
        
        graphicsLayer.clearLayers();
        
        const marker = L.marker([lat, lon], { color: 'red' }).addTo(graphicsLayer);
        map.setView([lat, lon], 16);
    } 

    function drawPoints(point1, point2) {
        if (currentPolygon) graphicsLayer.removeLayer(currentPolygon);
        drawMarker(point1, 'green');
        drawMarker(point2, 'red');
        map.fitBounds(L.latLngBounds([point1.lat, point1.lon], [point2.lat, point2.lon]));
    }

    // Функция отображения нескольких маршрутов
    function displayRoutes(routes, virtualSegment1, virtualSegment2) {
        // Очищаем предыдущие маршруты и кнопки
        routeLayers.forEach(layer => map.removeLayer(layer));
        routeLayers = [];
        document.getElementById('controls').innerHTML = ''; // Очистка предыдущих кнопок

        routes.forEach((route, index) => {
            const routeDistance = (route.distance / 1000).toFixed(2);  // Преобразуем расстояние в километры
            let fullRouteCoordinates = [...virtualSegment1, ...route.geometry.coordinates, ...virtualSegment2];

            // Удаляем все дополнительные и ненужные сегменты после конечной точки
            // Это особенно важно, чтобы убрать короткие линии в никуда
            fullRouteCoordinates = removeExtraSegments(fullRouteCoordinates);

            const routeStyle = {
                color: index === 0 ? 'blue' : 'gray',
                weight: index === 0 ? 6 : 4,
                opacity: 0.8,
                dashArray: index === 0 ? null : '10, 10',
                lineJoin: 'round'
            };

            // Добавляем маршрут на карту
            const routeLayer = L.geoJSON({
                type: "Feature",
                geometry: {
                    type: "LineString",
                    coordinates: fullRouteCoordinates
                }
            }, { style: routeStyle }).addTo(map);

            routeLayers.push(routeLayer);

            // Добавляем кнопку выбора маршрута
            const button = document.createElement('button');
            button.classList.add('route-button');
            button.textContent = `Маршрут ${index + 1} - ${routeDistance} км`;
            button.onclick = () => selectRoute(index, routes, virtualSegment1, virtualSegment2);
            document.getElementById('controls').appendChild(button);
        });

        // Устанавливаем видимость карты на первый маршрут
        map.fitBounds(routeLayers[0].getBounds());
    }

    // Удаляем лишние сегменты после конечной точки
    function removeExtraSegments(coordinates) {
        if (coordinates.length < 2) return coordinates; // Если нет сегментов, не трогаем

        // Проверяем, что последний сегмент действительно идет к конечной точке
        let finalPoint = coordinates[coordinates.length - 1];
        let penultimatePoint = coordinates[coordinates.length - 2];

        // Если конечная точка близка к предыдущей, то мы не добавляем никаких лишних сегментов
        if (calculateDistance(finalPoint[1], finalPoint[0], penultimatePoint[1], penultimatePoint[0]) < 1) {
            // Убираем последний сегмент, если он короткий и указывает "в никуда"
            coordinates.pop();
        }

        return coordinates.filter((coord, index, self) => {
            return index === 0 || coord[0] !== self[index - 1][0] || coord[1] !== self[index - 1][1];
        });
    }


    function projectPointOnSegment(lat, lon, { lon: x1, lat: y1 }, { lon: x2, lat: y2 }) {
        const dx = x2 - x1, dy = y2 - y1;
        if (!dx && !dy) return { lat: y1, lon: x1 };

        const t = Math.max(0, Math.min(1, ((lon - x1) * dx + (lat - y1) * dy) / (dx * dx + dy * dy)));
        return { lat: y1 + t * dy, lon: x1 + t * dx };
    }

    // Функция для расчета расстояния между двумя точками на Земле (Haversine)
    function calculateDistance(lat1, lon1, lat2, lon2) {
        if (lat1 == null || lon1 == null || lat2 == null || lon2 == null) {
            return Infinity; // Возвращаем бесконечность, если координаты неопределены
        }
        const toRadians = (deg) => deg * Math.PI / 180;
        const R = 6371e3;  // Радиус Земли в метрах
        const dLat = toRadians(lat2 - lat1);
        const dLon = toRadians(lon2 - lon1);
        const lat1Rad = toRadians(lat1);
        const lat2Rad = toRadians(lat2);

        const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1Rad) * Math.cos(lat2Rad) * Math.sin(dLon / 2) ** 2;
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    // Функция поиска ближайших дорог для стартовой и конечной точек и построения маршрута
    function findNearestRoadAndBuildRoute() {
        if (!startPoint || !endPoint) return;

        routeInProgress = true;

        findNearestRoadGoogleMaps(startPoint.lat, startPoint.lng, road1 => {
            if (!road1) return console.log("Не удалось найти дорогу для стартовой точки.");

            findNearestRoadGoogleMaps(endPoint.lat, endPoint.lng, road2 => {
                if (!road2) return console.log("Не удалось найти дорогу для конечной точки.");

                // Строим виртуальные пути от начальной и конечной точек до дорог
                drawVirtualPath(startPoint, road1, virtualSegment1 => {
                    drawVirtualPath(endPoint, road2, virtualSegment2 => {
                        buildRoute(road1, road2, routes => {
                            displayRoutes(routes, virtualSegment1, virtualSegment2);
                        });
                    });
                });
            });
        });
    }

    function findNearestRoadGoogleMaps(lat, lon, callback) {
        const roadUrl = `https://roads.googleapis.com/v1/nearestRoads?points=${lat},${lon}&key=AIzaSyAF9wXnuAelc_5poABepWFKPIG0WQ-UWjw`;

        fetch(roadUrl)
            .then(response => response.json())
            .then(data => {
                if (data.snappedPoints && data.snappedPoints.length > 0) {
                    const snappedPoint = data.snappedPoints[0].location;
                    const originalPoint = { lat: lat, lon: lon };
                    const snappedCoords = { lat: snappedPoint.latitude, lon: snappedPoint.longitude };

                    // Определяем центр дороги путем анализа ближайших двух точек
                    if (data.snappedPoints.length > 1) {
                        const nextSnappedPoint = data.snappedPoints[1].location;
                        const midPoint = calculateMidPoint(snappedCoords, {
                            lat: nextSnappedPoint.latitude,
                            lon: nextSnappedPoint.longitude,
                        });

                        callback({ x: midPoint.lon, y: midPoint.lat });
                        console.log('Midpoint of road:', midPoint.lat, midPoint.lon);
                    } else {
                        // Если единственная точка, возвращаем её
                        callback({ x: snappedCoords.lon, y: snappedCoords.lat });
                        console.log('Snapped Road Coordinates:', snappedCoords.lat, snappedCoords.lon);
                    }
                } else {
                    console.log('Не удалось найти ближайшую дорогу.');
                    callback(null);
                }
            })
            .catch(error => {
                console.log('Ошибка при запросе Roads API:', error);
                callback(null);
            });
    }

    // Функция для расчета среднего значения двух координат (центра)
    function calculateMidPoint(point1, point2) {
        const midLat = (point1.lat + point2.lat) / 2;
        const midLon = (point1.lon + point2.lon) / 2;
        return { lat: midLat, lon: midLon };
    }

    function buildRoute(road1, road2, callback) {
        if (!road1 || !road2) {
            console.log('Не удалось найти ближайшую дорогу для одной из точек.');
            return;
        }

        const origin = `${road1.y},${road1.x}`;
        const destination = `${road2.y},${road2.x}`;

        if (origin === destination) {
            console.log('Начальная и конечная точки маршрута совпадают.');
            return;
        }

        const routeUrl = `${domainUrl}/wp-json/my_map_plugin/v1/proxy/google-maps/maps/api/directions/json?origin=${origin}&destination=${destination}&alternatives=false`;

        fetch(routeUrl)
            .then(response => {
                if (!response.ok) {
                    console.log('Ошибка при запросе маршрута:', response.statusText);
                    throw new Error('Ошибка при запросе маршрута');
                }
                return response.json();
            })
            .then(data => {
                if (data.routes && data.routes.length > 0) {
                    const route = data.routes[0];

                    if (!route.overview_polyline) {
                        console.log('Полилиния маршрута отсутствует.');
                        return;
                    }

                    const decodedPath = google.maps.geometry.encoding.decodePath(route.overview_polyline.points).map(latlng => ({
                        lat: latlng.lat(),
                        lon: latlng.lng()
                    }));

                    // Получаем перекрестки из анализа углов поворота
                    const angleIntersections = findIntersections(decodedPath);

                    // Получаем перекрестки с Overpass API
                    getRouteIntersections(decodedPath, overpassIntersections => {
                        // Объединяем и удаляем дубликаты
                        const allIntersections = [...angleIntersections, ...overpassIntersections];
                        const manholeLocations = removeDuplicateIntersections(allIntersections);

                        // Создаем объект маршрута
                        const routeObject = {
                            geometry: { coordinates: decodedPath.map(p => [p.lon, p.lat]) },
                            distance: route.legs[0].distance.value,
                            manholes: manholeLocations
                        };

                        callback([routeObject]);
                    });

                } else {
                    console.log('Маршруты не найдены.', data.status, data.error_message);
                    console.log(`Маршруты не найдены: ${data.status} - ${data.error_message || 'Неизвестная ошибка'}`);
                }
            })
            .catch(error => {
                console.log('Ошибка при построении маршрута:', error);
                console.log(`Ошибка при построении маршрута: ${error.message}`);
            });
    }

    function removeDuplicateIntersections(intersections) {
        const uniqueIntersections = [];
        const seen = new Set();

        intersections.forEach(({ lat, lon }) => {
            const key = `${lat.toFixed(5)},${lon.toFixed(5)}`;
            if (!seen.has(key)) {
                seen.add(key);
                uniqueIntersections.push({ lat, lon });
            }
        });

        return uniqueIntersections;
    }

    // Функция для определения перекрестков на маршруте
    function findIntersections(routeCoordinates) {
        const intersections = [];
        for (let i = 1; i < routeCoordinates.length - 1; i++) {
            const angle = calculateTurnAngle(
                routeCoordinates[i - 1],
                routeCoordinates[i],
                routeCoordinates[i + 1]
            );
            if (angle < 170) { // Пороговое значение для определения перекрестка
                intersections.push({
                    lat: routeCoordinates[i].lat,
                    lon: routeCoordinates[i].lon
                });
            }
        }
        return intersections;
    }

    function getRouteIntersections(routeCoordinates, callback) {
        const overpassUrl = 'https://overpass-api.de/api/interpreter';

        // Создаем полигон из координат маршрута
        const routePolygon = coordinatesToPolyString(routeCoordinates);

        // Формируем запрос Overpass QL
        const query = `
        [out:json][timeout:25];
        (
        way["highway"](poly: "${routePolygon}");
        );
        node(w)->.nodes;
        .nodes out;
        `;

        fetch(overpassUrl, {
            method: 'POST',
            body: query
        })
        .then(response => response.json())
        .then(data => {
            if (data.elements) {
                // Группируем по узлам, где пересекаются несколько дорог
                const nodeCounts = {};
                data.elements.forEach(element => {
                    if (element.type === 'node' && element.lat != null && element.lon != null) {
                        const key = `${element.lat.toFixed(5)},${element.lon.toFixed(5)}`;
                        nodeCounts[key] = (nodeCounts[key] || 0) + 1;
                    }
                });

                // Выбираем узлы, где пересекаются более одной дороги
                const intersections = [];
                for (const key in nodeCounts) {
                    if (nodeCounts[key] > 1) {
                        const [lat, lon] = key.split(',').map(Number);
                        intersections.push({ lat, lon });
                    }
                }

                callback(intersections);
            } else {
                console.log('Нет данных от Overpass API.');
                callback([]);
            }
        })
        .catch(error => {
            console.log('Ошибка при запросе Overpass API:', error);
            callback([]);
        });
    }

    // Вспомогательная функция для преобразования координат в строку полигона
    function coordinatesToPolyString(coordinates) {
        return coordinates.map(coord => `${coord.lon} ${coord.lat}`).join(' ');
    }

    function filterIntersections(intersections, callback) {
        const overpassUrl = 'https://overpass-api.de/api/interpreter';

        // Проверяем, есть ли перекрестки для обработки
        if (intersections.length === 0) {
            console.warn('Нет перекрестков для фильтрации.');
            callback([]);
            return;
        }

        // Формируем запрос для каждого перекрестка
        const queries = intersections.map(({ lat, lon }) => `
        (
        way(around:10,${lat},${lon})["highway"];
        );
        out tags;`).join('');

        const fullQuery = `[out:json][timeout:25];${queries}`;

        fetch(overpassUrl, {
            method: 'POST',
            body: fullQuery
        })
        .then(response => response.json())
        .then(data => {
            const elements = data.elements || [];

            // Группируем пути по координатам перекрестков
            const waysByIntersection = {};
            elements.forEach(element => {
                if (element.type === 'way' && element.tags && element.tags.highway) {
                    intersections.forEach(({ lat, lon }) => {
                        const distance = calculateDistance(lat, lon, element.center ? element.center.lat : 0, element.center ? element.center.lon : 0);
                        if (distance < 15) { // Проверяем, что путь близок к перекрестку
                            const key = `${lat.toFixed(5)},${lon.toFixed(5)}`;
                            if (!waysByIntersection[key]) waysByIntersection[key] = [];
                            waysByIntersection[key].push(element);
                        }
                    });
                }
            });

            const filteredIntersections = intersections.filter(({ lat, lon }) => {
                if (lat == null || lon == null) {
                    console.log('Undefined lat or lon in intersection:', { lat, lon });
                    return false; // Пропустить этот перекресток
                }
                const key = `${lat.toFixed(5)},${lon.toFixed(5)}`;
                const ways = waysByIntersection[key] || [];
            
                // Проверяем количество дорог и наличие частных дорог
                if (ways.length > 1) {
                    const hasPrivateRoad = ways.some(way => way.tags.access === 'private');
                    return !hasPrivateRoad;
                }
                return false;
            });        

            callback(filteredIntersections);
        })
        .catch(error => {
            console.log('Ошибка при запросе Overpass API:', error);
            callback([]);
        });
    }

    // Функция для размещения колодцев на перекрестках без дубликатов
    function placeManholesAtIntersections(intersections) {
        const manholeLocations = [];
        const seenIntersections = new Set();
        intersections.forEach(({ lat, lon }) => {
            if (lat == null || lon == null) {
                console.log('Undefined lat or lon in intersection:', { lat, lon });
                return; // Пропускаем этот перекресток
            }
            const key = `${lat.toFixed(5)},${lon.toFixed(5)}`;
            if (!seenIntersections.has(key)) {
                seenIntersections.add(key);
                manholeLocations.push({ lat, lon });
            }
        });
        return manholeLocations;
    }

    function adjustRouteThroughManholes(path) {
        const adjustedPath = [];
        
        path.forEach((point, index) => {
            adjustedPath.push(point);

            // Найти ближайший колодец для текущего сегмента маршрута
            manholes.forEach(manhole => {
                const closestSegment = findClosestSegment([point, path[index + 1]], manhole);
                const distanceToManhole = calculateDistance(manhole.lat, manhole.lon, closestSegment.start.lat, closestSegment.start.lon);
                
                // Добавляем колодец только если он действительно близко к текущему маршруту
                if (distanceToManhole < 50) {
                    adjustedPath.push({ lat: manhole.lat, lon: manhole.lon });
                }
            });
        });

        return adjustedPath;
    }

    function findClosestSegment(path, manhole) {
        let closestSegment = null;
        let minDistance = Infinity;

        for (let i = 0; i < path.length - 1; i++) {
            const segmentStart = path[i];
            const segmentEnd = path[i + 1];
            const projectedPoint = projectPointOnSegment(manhole.lat, manhole.lon, segmentStart, segmentEnd);
            const distanceToSegment = calculateDistance(manhole.lat, manhole.lon, projectedPoint.lat, projectedPoint.lon);

            if (distanceToSegment < minDistance) {
                minDistance = distanceToSegment;
                closestSegment = { start: segmentStart, end: segmentEnd, index: i + 1 };
            }
        }

        return closestSegment;
    }

    function drawVirtualPath(point, road, callback) {
        const roadPoint = { lat: road.y, lon: road.x };

        if (isNaN(roadPoint.lat) || isNaN(roadPoint.lon)) {
            console.log('Некорректные координаты дороги для выхода.');
            return callback(null);
        }

        // Рассчитываем разницу координат между точками
        const deltaX = roadPoint.lon - point.lon;
        const deltaY = roadPoint.lat - point.lat;
        const length = Math.hypot(deltaX, deltaY); // Длина вектора между точками

        // Если длина очень мала, не делаем сокращение (оставляем как есть)
        if (length < 0.00005) {
            console.log('Маршрут слишком короткий, строим его напрямую.');
            const pathCoordinates = [
                [point.lon, point.lat],
                [roadPoint.lon, roadPoint.lat] // Прямо до дороги
            ];
            L.polyline(pathCoordinates, {
                color: 'green',
                weight: 3,
                dashArray: '5, 10'
            }).addTo(map);

            if (!firstExitToRoadAdded) {
                addManholeOnFirstExitToRoad(roadPoint, 0);
                firstExitToRoadAdded = true;
            }

            return callback(pathCoordinates);
        }

        // Нормализуем направление движения
        const unitX = deltaX / length;
        const unitY = deltaY / length;

        // Устанавливаем точку немного перед дорогой
        const distanceFromRoad = 0.00005;
        const preRoadPoint = {
            lon: point.lon + unitX * (length - distanceFromRoad),
            lat: point.lat + unitY * (length - distanceFromRoad)
        };

        // Строим маршрут до preRoadPoint
        const pathCoordinates = [
            [point.lon, point.lat],          // Начальная точка
            [preRoadPoint.lon, preRoadPoint.lat]  // Точка перед дорогой
        ];

        // Рисуем путь на карте
        L.polyline(pathCoordinates, {
            color: 'green',
            weight: 3,
            dashArray: '5, 10'
        }).addTo(map);

        // Добавляем колодец при первом выходе на дорогу
        if (!firstExitToRoadAdded) {
            addManholeOnFirstExitToRoad(roadPoint, 0);
            firstExitToRoadAdded = true;
        }

        callback(pathCoordinates);
    }

    function removeExtraSegments(coordinates) {
        if (coordinates.length < 2) return coordinates; 

        // Проверяем, что последний сегмент действительно идет к конечной точке
        let finalPoint = coordinates[coordinates.length - 1];
        let penultimatePoint = coordinates[coordinates.length - 2];

        // Если конечная точка близка к предыдущей или последний сегмент слишком короткий, убираем его
        if (calculateDistance(finalPoint[1], finalPoint[0], penultimatePoint[1], penultimatePoint[0]) < 1) {
            console.log('Удаляем короткий сегмент.');
            coordinates.pop();
        }

        return coordinates;
    }

    function addManholeOnFirstExitToRoad(location, elevation) {
        if (firstExitToRoadAdded) return;

        firstExitToRoadAdded = true;
        firstManhole = {
            location,
            type: 'manhole',
            depth: 1.5,
            elevation: elevation || 0 // Если высота не известна, устанавливаем 0
        };
        createMarker(location, 'manhole', 1.5);
    }

    function createMarker(location, type, depth) {
        const isPump = type === 'pump';
        const markerOptions = {
            radius: isPump ? 8 : 6,
            color: isPump ? 'red' : 'blue',
            fillColor: isPump ? 'red' : 'blue',
            fillOpacity: 0.9,
            weight: 2
        };
        const description = `${isPump ? 'Насосный колодец' : 'Колодец'}: глубина ${depth.toFixed(2)} м`;

        L.circleMarker([location.lat, location.lon], markerOptions)
            .bindPopup(description)
            .addTo(manholeLayer);
    }

    function visualizeManholesAndPipes(manholes, pipes) {
        pipeLayer.clearLayers();
        manholeLayer.clearLayers();

        // Отображение труб
        pipes.forEach(pipe => {
            L.polyline(
                [
                    [pipe.start.lat, pipe.start.lon],
                    [pipe.end.lat, pipe.end.lon]
                ],
                { color: 'green', weight: 4, opacity: 0.7 }
            ).addTo(pipeLayer);
        });

        // Отображение колодцев и насосов
        manholes.forEach(({ location, type, depth }) => createMarker(location, type, depth));
    }

    // Функция выбора маршрута
    function selectRoute(index, routes, virtualSegment1, virtualSegment2) {
        routeLayers.forEach(layer => map.removeLayer(layer));
        routeLayers = [];

        // Объединяем координаты маршрута без дублирования точек
        const selectedRouteCoordinates = [
            ...virtualSegment1.slice(0, -1),
            ...routes[index].geometry.coordinates,
            ...virtualSegment2.slice(1)
        ];

        // Удаляем дублирующиеся точки
        const uniqueCoordinates = selectedRouteCoordinates.filter((coord, idx, arr) => {
            return idx === 0 || coord[0] !== arr[idx - 1][0] || coord[1] !== arr[idx - 1][1];
        });

        const fullRoute = {
            type: "Feature",
            geometry: { type: "LineString", coordinates: uniqueCoordinates }
        };

        const selectedRouteLayer = L.geoJSON(fullRoute, {
            style: { color: 'blue', weight: 6, opacity: 0.8 }
        }).addTo(map);
        routeLayers.push(selectedRouteLayer);

        map.fitBounds(selectedRouteLayer.getBounds());

        // Удаляем сброс переменной firstManhole
        // firstManhole = null;
        firstExitToRoadAdded = false;

        // Построение системы канализации по выбранному маршруту
        buildSewerSystem(
            uniqueCoordinates.map(([lon, lat]) => ({ lat, lon })),
            routes[index].manholes
        );
    }

    // Функция для получения рельефа с OpenTopoData
    function getElevationDataOpenTopoData(coordinates, callback) {
        const locations = coordinates.map(({ lat, lon }) => `${lat},${lon}`).join('|');
        if (elevationCache[locations]) return callback(elevationCache[locations]);

        const url = `https://api.opentopodata.org/v1/eudem25m?locations=${locations}`;
        fetch(url)
            .then(response => response.json())
            .then(data => {
                const elevations = data.results?.map(result => result.elevation ?? null) || [];
                elevationCache[locations] = elevations;
                callback(elevations);
            })
            .catch(error => {
                console.log('Ошибка при запросе рельефа:', error);
                callback(null);
            });
    }


    function calculateTurnAngle(point1, point2, point3) {
        const [dx1, dy1] = [point2.lat - point1.lat, point2.lon - point1.lon];
        const [dx2, dy2] = [point3.lat - point2.lat, point3.lon - point2.lon];
        
        // Скалярное произведение и длины векторов
        const dotProduct = dx1 * dx2 + dy1 * dy2;
        const magnitude1 = Math.hypot(dx1, dy1);
        const magnitude2 = Math.hypot(dx2, dy2);
        
        // Корректируем возможные ошибки округления и находим угол
        const cosTheta = Math.min(1, Math.max(-1, dotProduct / (magnitude1 * magnitude2)));
        return Math.acos(cosTheta) * (180 / Math.PI);
    }

    function drawElevationProfile(elevations, distances, manholes = [], pipes = []) {
        const ctx = document.getElementById('elevationCanvas').getContext('2d');

        // Удаляем предыдущий график, если он существует
        if (window.elevationChart) {
            window.elevationChart.destroy();
        }

        // Подготовка данных для графика
        const pipeData = [];
        pipes.forEach(pipe => {
            pipeData.push(
                { x: pipe.distanceStart, y: elevations[distances.findIndex(d => d >= pipe.distanceStart)] - pipe.depthStart },
                { x: pipe.distanceEnd, y: elevations[distances.findIndex(d => d >= pipe.distanceEnd)] - pipe.depthEnd }
            );
        });

        // Аннотации для колодцев и насосов
        const annotations = manholes.map(manhole => ({
            type: 'point',
            xValue: manhole.distance,
            yValue: manhole.elevation - manhole.depth,
            backgroundColor: manhole.type === 'pump' ? 'red' : 'blue',
            radius: 5,
            label: {
                content: manhole.type === 'pump' ? 'Насос' : 'Колодец',
                enabled: true,
                position: 'top',
            }
        }));

        // Создаем новый график
        window.elevationChart = new Chart(ctx, {
            type: 'line',
            data: {
                datasets: [
                    {
                        label: 'Рельеф поверхности',
                        data: distances.map((distance, i) => ({ x: distance, y: elevations[i] })),
                        fill: false,
                        borderColor: 'blue',
                        tension: 0.1,
                        pointRadius: 0
                    },
                    {
                        label: 'Глубина трубы',
                        data: pipeData,
                        fill: false,
                        borderColor: 'green',
                        borderDash: [5, 5],
                        tension: 0,
                        pointRadius: 0,
                        stepped: true
                    }
                ]
            },
            options: {
                scales: {
                    x: {
                        type: 'linear',
                        position: 'bottom',
                        title: {
                            display: true,
                            text: 'Расстояние (м)',
                        }
                    },
                    y: {
                        title: {
                            display: true,
                            text: 'Высота над уровнем моря (м)',
                        },
                        min: Math.min(...pipeData.map(p => p.y)) - 5,
                        max: Math.max(...elevations) + 5
                    }
                },
                plugins: {
                    annotation: {
                        annotations: annotations,
                    }
                }
            }
        });
    }

    function buildSewerSystem(routeCoordinates, manholeLocations) {
        console.log("Запуск построения системы канализации...");

        // Очищаем слои труб и колодцев
        pipeLayer.clearLayers();
        manholeLayer.clearLayers();

        getElevationDataOpenTopoData(routeCoordinates, elevations => {
            if (!elevations) return console.log('Не удалось получить данные рельефа.');

            console.log("Данные рельефа успешно получены:", elevations);

            // Расчет расстояний
            const distances = [];
            let totalDistance = 0;
            for (let i = 0; i < routeCoordinates.length; i++) {
                if (i > 0) {
                    const segmentDistance = calculateDistance(
                        routeCoordinates[i - 1].lat,
                        routeCoordinates[i - 1].lon,
                        routeCoordinates[i].lat,
                        routeCoordinates[i].lon
                    );
                    totalDistance += segmentDistance;
                }
                distances.push(totalDistance);
            }

            console.log("Рассчитанные расстояния по маршруту:", distances);

            // Расчет колодцев и труб
            const { manholes, pipes } = calculateManholesAndPipes(routeCoordinates, elevations, manholeLocations);

            // Если существует firstManhole, обновляем его distance и добавляем в manholes
            if (firstManhole) {
                // Находим индекс точки в маршруте, соответствующей firstManhole
                const index = routeCoordinates.findIndex(coord =>
                    coord.lat.toFixed(5) === firstManhole.location.lat.toFixed(5) &&
                    coord.lon.toFixed(5) === firstManhole.location.lon.toFixed(5)
                );

                let distance = 0;
                if (index >= 0) {
                    distance = distances[index];
                } else {
                    // Если не нашли, используем расстояние до первой точки
                    distance = 0;
                }

                manholes.push({
                    ...firstManhole,
                    distance: distance
                });
            }

            // Отрисовка профиля высот
            drawElevationProfile(elevations, distances, manholes, pipes);

            if (manholes.length && pipes.length) {
                visualizeManholesAndPipes(manholes, pipes);
            } else {
                console.log("Manholes or pipes are empty.");
            }
        });
    }

    function calculateManholesAndPipes(routeCoordinates, elevations, manholeLocations) {
        const manholes = [];
        const pipes = [];
        const initialDepth = 1.5; // Начальная глубина
        const maxDepth = 3; // Максимальная глубина
        const slopePromille = 4 / 1000; // Уклон 4 промилле
        let currentDepth = initialDepth;
        let previousElevation = elevations[0];
        let accumulatedDistance = 0;

        // Интервал для установки колодцев (например, каждые 100 метров)
        const manholeInterval = 100;
        let nextManholeDistance = manholeInterval;

        // Всегда добавляем насос на начальной точке
        manholes.push({
            location: routeCoordinates[0],
            type: 'pump',
            depth: currentDepth,
            elevation: elevations[0],
            distance: 0
        });

        for (let i = 1; i < routeCoordinates.length; i++) {
            const segmentDistance = calculateDistance(
                routeCoordinates[i - 1].lat,
                routeCoordinates[i - 1].lon,
                routeCoordinates[i].lat,
                routeCoordinates[i].lon
            );

            accumulatedDistance += segmentDistance;

            const elevationDifference = elevations[i] - previousElevation;
            const depthChange = segmentDistance * slopePromille;
            currentDepth += depthChange - elevationDifference;

            pipes.push({
                start: routeCoordinates[i - 1],
                end: routeCoordinates[i],
                depthStart: currentDepth - depthChange + elevationDifference,
                depthEnd: currentDepth,
                distanceStart: accumulatedDistance - segmentDistance,
                distanceEnd: accumulatedDistance
            });

            const isManholeLocation = manholeLocations.some(loc =>
                Math.abs(loc.lat - routeCoordinates[i].lat) < 0.0001 &&
                Math.abs(loc.lon - routeCoordinates[i].lon) < 0.0001
            );

            const isTimeForManhole = accumulatedDistance >= nextManholeDistance;

            if (currentDepth > maxDepth || isManholeLocation || isTimeForManhole) {
                // Устанавливаем колодец и обновляем глубину
                currentDepth = Math.max(currentDepth - 1.5, initialDepth);
                manholes.push({
                    location: routeCoordinates[i],
                    type: isManholeLocation ? 'manhole' : 'interval_manhole',
                    depth: currentDepth,
                    elevation: elevations[i],
                    distance: accumulatedDistance
                });

                if (isTimeForManhole) {
                    nextManholeDistance += manholeInterval;
                }
            }

            previousElevation = elevations[i];
        }

        // Проверяем наличие конечного колодца
        const lastPoint = routeCoordinates[routeCoordinates.length - 1];
        const lastManholeExists = manholes.some(manhole =>
            manhole.location.lat === lastPoint.lat && manhole.location.lon === lastPoint.lon
        );

        if (!lastManholeExists) {
            manholes.push({
                location: lastPoint,
                type: 'manhole',
                depth: currentDepth,
                elevation: elevations[elevations.length - 1],
                distance: accumulatedDistance
            });
        }

        console.log(`Создано колодцев: ${manholes.length}, труб: ${pipes.length}`);

        return { manholes, pipes };
    }



    //buttons

    initializeMap();
    autofillCoordinates(); // Автозаполнение полей координат из cookie

    // Переключение между режимами (mode1 и mode2)
    document.getElementById('modeSelect').addEventListener('change', function (event) {
        toggleMode(event.target.value);
    });

    // Обработка поиска адреса для мода 1
    document.getElementById('searchButton1').addEventListener('click', function () {
        const address = document.getElementById('addressInput').value;
        if (address) searchAddressAndCreatePolygon(address);
    });

    // Обработка поиска по координатам для мода 2
    document.getElementById('searchButton2').addEventListener('click', function () {
        const coordinatesPoint1 = document.getElementById('coordinatesPoint1').value;
        const coordinatesPoint2 = document.getElementById('coordinatesPoint2').value;

        handleCoordinateSearch(coordinatesPoint1, coordinatesPoint2);
    });

    // Вспомогательные функции
    function toggleMode(selectedMode) {
        const mode1Fields = document.getElementById('mode1Fields');
        const mode2Fields = document.getElementById('mode2Fields');
        if (selectedMode === 'mode1') {
            mode1Fields.classList.remove('hidden');
            mode2Fields.classList.add('hidden');
        } else {
            mode1Fields.classList.add('hidden');
            mode2Fields.classList.remove('hidden');
        }
    }

    function handleCoordinateSearch(coord1, coord2) {
        const point1 = parseCoordinates(coord1);
        const point2 = parseCoordinates(coord2);

        if (point1 && point2) {
            inputCoordinatesMode = true; // Активируем режим ручного ввода координат
            drawPoints(point1, point2);

            // Поиск ближайших дорог для обеих точек и построение маршрута
            findNearestRoadGoogleMaps(point1.lat, point1.lon, function (road1) {
                if (road1) {
                    drawVirtualPath(point1, road1, function (virtualSegment1) {
                        if (virtualSegment1) {
                            findNearestRoadGoogleMaps(point2.lat, point2.lon, function (road2) {
                                if (road2) {
                                    drawVirtualPath(point2, road2, function (virtualSegment2) {
                                        if (virtualSegment2) {
                                            // Call buildRoute with the new structure to handle multiple routes
                                            buildRoute(road1, road2, function (routes) {
                                                if (routes && routes.length > 0) {
                                                    displayRoutes(routes, virtualSegment1, virtualSegment2); // Display multiple routes
                                                } else {
                                                    console.log('Нет доступных маршрутов.');
                                                }
                                            });
                                        }
                                    });
                                }
                            });
                        }
                    });
                }
            });
        } else {
            console.log('Введите корректные координаты.');
        }
    }

    function parseCoordinates(coordinateString) {
        const coords = coordinateString.split(',');
        if (coords.length === 2) {
            const lat = parseFloat(coords[0].trim());
            const lon = parseFloat(coords[1].trim());
            return (!isNaN(lat) && !isNaN(lon)) ? { lat, lon } : null;
        }
        return null;
    }

    // Функции для работы с cookie
    function autofillCoordinates() {
        const point1Cookie = getCookie('coordinatesPoint1');
        const point2Cookie = getCookie('coordinatesPoint2');

        if (point1Cookie) document.getElementById('coordinatesPoint1').value = point1Cookie;
        if (point2Cookie) document.getElementById('coordinatesPoint2').value = point2Cookie;
    }

    function setCookie(name, value, days) {
        const date = new Date();
        date.setTime(date.getTime() + (days * 24 * 60 * 60 * 1000));  // Days to milliseconds
        const expires = "expires=" + date.toUTCString();
        document.cookie = `${name}=${value};${expires};path=/`;
    }  

    function getCookie(name) {
        const nameEQ = name + "=";
        const decodedCookie = decodeURIComponent(document.cookie);
        const cookieArray = decodedCookie.split(';');
        for (let i = 0; i < cookieArray.length; i++) {
            let cookie = cookieArray[i].trim();
            if (cookie.indexOf(nameEQ) === 0) return cookie.substring(nameEQ.length);
        }
        return null;
    }

    function eraseCookie(name) {
        setCookie(name, "", -1);
    }
    
});
