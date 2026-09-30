import React, { useRef, useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import { WebView } from 'react-native-webview';

interface Coords {
  latitude: number;
  longitude: number;
}

interface LeafletMapViewProps {
  userCoords: Coords | null;
  targetCoords: Coords | null;
  targetName: string;
  radiusKm: number;
  isTracking: boolean;
  onMapPress: (coords: Coords) => void;
}

export const LeafletMapView: React.FC<LeafletMapViewProps> = ({
  userCoords,
  targetCoords,
  targetName,
  radiusKm,
  isTracking,
  onMapPress,
}) => {
  const webViewRef = useRef<WebView | null>(null);

  const initialLat = targetCoords?.latitude || userCoords?.latitude || -6.1754;
  const initialLon = targetCoords?.longitude || userCoords?.longitude || 106.8272;

  // HTML + Leaflet.js
  const htmlContent = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
      <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
      <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
      <style>
        body, html, #map {
          height: 100%;
          width: 100%;
          margin: 0;
          padding: 0;
          background-color: #0f172a;
        }
        .leaflet-container {
          background-color: #0f172a !important;
        }
        .user-marker-icon {
          background-color: #38bdf8;
          border: 3px solid #ffffff;
          border-radius: 50%;
          box-shadow: 0 0 12px #38bdf8;
        }
      </style>
    </head>
    <body>
      <div id="map"></div>
      <script>
        var map = L.map('map', { zoomControl: false }).setView([${initialLat}, ${initialLon}], 13);
        
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
          maxZoom: 19,
          attribution: '© OpenStreetMap'
        }).addTo(map);

        var userMarker = null;
        var targetMarker = null;
        var radiusCircle = null;
        var routePolyline = null;

        var userIcon = L.divIcon({
          className: 'user-marker-icon',
          iconSize: [18, 18],
          iconAnchor: [9, 9]
        });

        // Event Klik Peta
        map.on('click', function(e) {
          window.ReactNativeWebView.postMessage(JSON.stringify({
            type: 'MAP_TAP',
            latitude: e.latlng.lat,
            longitude: e.latlng.lng
          }));
        });

        function updateMapState(data) {
          // 1. Update Target Marker & Circle
          if (data.targetCoords) {
            var tLat = data.targetCoords.latitude;
            var tLon = data.targetCoords.longitude;
            
            if (targetMarker) {
              targetMarker.setLatLng([tLat, tLon]);
            } else {
              targetMarker = L.marker([tLat, tLon]).addTo(map);
            }
            targetMarker.bindPopup(data.targetName || 'Tujuan');

            if (radiusCircle) {
              radiusCircle.setLatLng([tLat, tLon]);
              radiusCircle.setRadius(data.radiusKm * 1000);
            } else {
              radiusCircle = L.circle([tLat, tLon], {
                color: '#ef4444',
                fillColor: '#ef4444',
                fillOpacity: 0.2,
                radius: data.radiusKm * 1000
              }).addTo(map);
            }
          }

          // 2. Update User Marker & Camera
          if (data.userCoords) {
            var uLat = data.userCoords.latitude;
            var uLon = data.userCoords.longitude;

            if (userMarker) {
              userMarker.setLatLng([uLat, uLon]);
            } else {
              userMarker = L.marker([uLat, uLon], { icon: userIcon }).addTo(map);
            }

            if (data.isTracking) {
              map.panTo([uLat, uLon]);
            }
          }

          // 3. Update Polyline Rute (Jika Tracking)
          if (data.userCoords && data.targetCoords && data.isTracking) {
            var pts = [
              [data.userCoords.latitude, data.userCoords.longitude],
              [data.targetCoords.latitude, data.targetCoords.longitude]
            ];
            if (routePolyline) {
              routePolyline.setLatLngs(pts);
            } else {
              routePolyline = L.polyline(pts, { color: '#38bdf8', weight: 4, dashArray: '8, 8' }).addTo(map);
            }
          } else if (routePolyline) {
            map.removeLayer(routePolyline);
            routePolyline = null;
          }
        }
      </script>
    </body>
    </html>
  `;

  // Suntikkan perubahan state ke WebView secara real-time
  useEffect(() => {
    if (!webViewRef.current) return;
    const data = {
      userCoords,
      targetCoords,
      targetName,
      radiusKm,
      isTracking,
    };
    const jsCode = `updateMapState(${JSON.stringify(data)}); true;`;
    webViewRef.current.injectJavaScript(jsCode);
  }, [userCoords, targetCoords, targetName, radiusKm, isTracking]);

  const handleMessage = (event: any) => {
    try {
      const data = JSON.parse(event.nativeEvent.data);
      if (data.type === 'MAP_TAP') {
        onMapPress({ latitude: data.latitude, longitude: data.longitude });
      }
    } catch (e) {
      console.error('Error membaca pesan Leaflet:', e);
    }
  };

  return (
    <View style={styles.container}>
      <WebView
        ref={webViewRef}
        originWhitelist={['*']}
        source={{ html: htmlContent }}
        onMessage={handleMessage}
        style={styles.webview}
        javaScriptEnabled={true}
        domStorageEnabled={true}
        scrollEnabled={false}
      />
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    ...StyleSheet.absoluteFill,
  },
  webview: {
    flex: 1,
    backgroundColor: '#0f172a',
  },
});
