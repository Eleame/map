<?php
/*
Plugin Name: Map Plugin
Description: WordPress plugin with map functionality, including direct requests to external APIs.
Version: 1.3
Author: Oleg
*/

if (!defined('ABSPATH')) exit; // Защита от прямого доступа

// Подключаем скрипты и стили
function my_map_plugin_enqueue_scripts() {
    wp_enqueue_style('leaflet-css', 'https://unpkg.com/leaflet@1.7.1/dist/leaflet.css');
    wp_enqueue_script('leaflet-js', 'https://unpkg.com/leaflet@1.7.1/dist/leaflet.js', [], null, true);
    wp_enqueue_script('esri-leaflet-js', 'https://unpkg.com/esri-leaflet@3.0.3/dist/esri-leaflet.js', ['leaflet-js'], null, true);
    wp_enqueue_script('chart-js', 'https://cdn.jsdelivr.net/npm/chart.js', [], null, true);

    // Подключаем основной скрипт плагина и передаем URL сайта
    wp_enqueue_script('my-map-plugin-js', plugins_url('/my-map-plugin.js', __FILE__), ['leaflet-js', 'esri-leaflet-js', 'chart-js'], null, true);
    wp_localize_script('my-map-plugin-js', 'myMapPluginData', [
        'domainUrl' => get_site_url(),
    ]);
}
add_action('wp_enqueue_scripts', 'my_map_plugin_enqueue_scripts');

// Шорткод для отображения карты и панели управления
function my_map_plugin_shortcode() {
    ob_start();
    ?>
    <div id="controls">
        <select id="modeSelect">
            <option value="mode1">Mode 1: Search plot by address</option>
            <option value="mode2">Mode 2: Find roads and connect points</option>
        </select>
        
        <div id="mode1Fields">
            <input type="text" id="addressInput" placeholder="Enter address" />
            <button id="searchButton1">Find and draw plot</button>
        </div>

        <div id="mode2Fields" class="hidden">
            <input type="text" id="coordinatesPoint1" placeholder="Coordinates of Point 1 (lat, lon)" />
            <input type="text" id="coordinatesPoint2" placeholder="Coordinates of Point 2 (lat, lon)" />
            <button id="searchButton2">Find roads and connect points</button>
        </div>
    </div>
    <div id="map" style="height: 500px;"></div> <!-- Элемент карты -->
    <canvas id="elevationCanvas" width="600" height="200"></canvas> <!-- Canvas для профиля высот -->
    <?php
    return ob_get_clean();
}
add_shortcode('my_map_plugin', 'my_map_plugin_shortcode');

// Прокси для Google Maps
function my_map_plugin_google_maps_proxy($request) {
    $path = $request->get_param('path');
    $apiKey = 'AIzaSyAF9wXnuAelc_5poABepWFKPIG0WQ-UWjw'; // Замените на актуальный API-ключ
    $url = 'https://maps.googleapis.com/maps/api/' . $path . '?' . $_SERVER['QUERY_STRING'] . '&key=' . $apiKey;
    
    $response = wp_remote_get($url, ['timeout' => 10]);
    if (is_wp_error($response)) {
        return new WP_Error('failed_request', 'Failed to retrieve data from Google Maps', ['status' => 500]);
    }
    
    $body = wp_remote_retrieve_body($response);
    return rest_ensure_response(json_decode($body));
}

// Прокси для GeoPortal
function my_map_plugin_geoportal_proxy($request) {
    $path = $request->get_param('path');
    $queryString = $_SERVER['QUERY_STRING'] ?? '';
    // Добавляем параметр f=json для принудительного возврата JSON
    $url = 'https://www.geoportal.lt/' . rawurlencode($path) . '?' . $queryString . '&f=json';

    error_log("Запрос к GeoPortal с полным URL: " . $url);

    $response = wp_remote_get($url, [
        'timeout' => 20,
        'headers' => [
            'Origin' => get_site_url(),
            'Referer' => get_site_url(),
            'User-Agent' => 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/85.0.4183.121 Safari/537.36',
            'X-Requested-With' => 'XMLHttpRequest'
        ],
    ]);

    if (is_wp_error($response)) {
        error_log("Ошибка запроса к GeoPortal: " . $response->get_error_message());
        return new WP_Error('failed_request', 'Ошибка при получении данных от GeoPortal', ['status' => 500]);
    }

    $response_code = wp_remote_retrieve_response_code($response);
    $body = wp_remote_retrieve_body($response);

    error_log("Код ответа от GeoPortal: " . $response_code);
    error_log("Тело ответа от GeoPortal (начало): " . substr($body, 0, 200));

    if (strpos($body, '<html') !== false) {
        error_log("Ответ от GeoPortal является HTML, а не JSON.");
        return new WP_Error('invalid_content_type', 'GeoPortal response is not JSON', ['status' => 500]);
    }

    $decodedBody = json_decode($body);
    if (json_last_error() !== JSON_ERROR_NONE) {
        error_log("Ошибка JSON: " . json_last_error_msg());
        return new WP_Error('invalid_json', 'Invalid JSON format in response', ['status' => 500]);
    }

    return rest_ensure_response($decodedBody);
}

// Прокси для OpenTopoData
function my_map_plugin_opentopodata_proxy($request) {
    $path = $request->get_param('path');
    $url = 'https://api.opentopodata.org/' . $path . '?' . $_SERVER['QUERY_STRING'];
    
    $response = wp_remote_get($url, ['timeout' => 10]);
    if (is_wp_error($response)) {
        return new WP_Error('failed_request', 'Failed to retrieve data from OpenTopoData', ['status' => 500]);
    }
    
    $body = wp_remote_retrieve_body($response);
    return rest_ensure_response(json_decode($body));
}

// CORS-заголовки для REST API
add_action('rest_api_init', function () {
    header("Access-Control-Allow-Origin: *");
    header("Access-Control-Allow-Methods: GET, POST, OPTIONS");
    header("Access-Control-Allow-Headers: Content-Type, Authorization");

    register_rest_route('my_map_plugin/v1', '/proxy/google-maps/(?P<path>.+)', [
        'methods' => 'GET',
        'callback' => 'my_map_plugin_google_maps_proxy',
        'permission_callback' => '__return_true',
    ]);

    register_rest_route('my_map_plugin/v1', '/proxy/geoportal/(?P<path>.+)', [
        'methods' => 'GET',
        'callback' => 'my_map_plugin_geoportal_proxy',
        'permission_callback' => '__return_true',
    ]);

    register_rest_route('my_map_plugin/v1', '/proxy/opentopodata/(?P<path>.+)', [
        'methods' => 'GET',
        'callback' => 'my_map_plugin_opentopodata_proxy',
        'permission_callback' => '__return_true',
    ]);
});
